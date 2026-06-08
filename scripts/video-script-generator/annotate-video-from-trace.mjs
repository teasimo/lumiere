#!/usr/bin/env node
/**
 * Reads a Playwright trace zip, derives test.step timing, builds a Remotion
 * intermediate artifact (plan + script), and then renders the annotated video
 * from that artifact.
 *
 * Usage:
 *   node scripts/video-script-generator/annotate-video-from-trace.mjs <trace.zip> <video.webm> [output.mp4]
 *     [--clip-start-ms=<ms>] [--clip-end-ms=<ms>]
 *     [--scenario-xml=<path>] [--intermediate-plan=<path>] [--plan-only]
 *     [--click-enabled=<bool>] [--click-before-ms=<ms>] [--click-after-ms=<ms>]
 *     [--click-fade-ms=<ms>] [--click-image=<path>]
 */

import { existsSync } from 'fs'
import { readFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, extname, join, resolve } from 'path'
import { execSync, spawnSync } from 'child_process'

const DEFAULT_CLICK_BEFORE_MS = 80
const DEFAULT_CLICK_AFTER_MS = 420
const DEFAULT_CLICK_FADE_MS = 0
const DEFAULT_CHAPTER_DURATION_MS = 2000

function getAnnotateMetaPath(filePath) {
  return `${filePath}.annotate-meta.json`
}

const rawArgs = process.argv.slice(2)
const positionalArgs = []
let clipStartMs = 0
let clipEndMs = null
let clipStartExplicit = false
let clipEndExplicit = false
let scenarioXmlPath = null
let intermediatePlanPath = null
let planOnly = false
let clickEnabled = true
let clickBeforeMs = DEFAULT_CLICK_BEFORE_MS
let clickAfterMs = DEFAULT_CLICK_AFTER_MS
let clickFadeMs = DEFAULT_CLICK_FADE_MS
let clickImagePath = null

for (const arg of rawArgs) {
  if (arg.startsWith('--clip-start-ms=')) {
    clipStartMs = Number.parseInt(arg.slice('--clip-start-ms='.length), 10)
    clipStartExplicit = true
    continue
  }
  if (arg.startsWith('--clip-end-ms=')) {
    clipEndMs = Number.parseInt(arg.slice('--clip-end-ms='.length), 10)
    clipEndExplicit = true
    continue
  }
  if (arg.startsWith('--scenario-xml=')) {
    scenarioXmlPath = String(arg.slice('--scenario-xml='.length)).trim() || null
    continue
  }
  if (arg.startsWith('--intermediate-plan=')) {
    intermediatePlanPath = String(arg.slice('--intermediate-plan='.length)).trim() || null
    continue
  }
  if (arg.startsWith('--remotion-script=')) {
    // Legacy flag: render TSX generation moved to run-annotated-video.mjs
    continue
  }
  if (arg === '--plan-only') {
    planOnly = true
    continue
  }
  if (arg === '--skip-remotion-script') {
    // Legacy flag: kept as no-op for CLI compatibility.
    continue
  }
  if (arg.startsWith('--click-enabled=')) {
    const raw = String(arg.slice('--click-enabled='.length)).trim().toLowerCase()
    clickEnabled = !(raw === 'false' || raw === '0' || raw === 'no')
    continue
  }
  if (arg.startsWith('--click-before-ms=')) {
    clickBeforeMs = Number.parseInt(arg.slice('--click-before-ms='.length), 10)
    continue
  }
  if (arg.startsWith('--click-after-ms=')) {
    clickAfterMs = Number.parseInt(arg.slice('--click-after-ms='.length), 10)
    continue
  }
  if (arg.startsWith('--click-fade-ms=')) {
    clickFadeMs = Number.parseInt(arg.slice('--click-fade-ms='.length), 10)
    continue
  }
  if (arg.startsWith('--click-image=')) {
    clickImagePath = String(arg.slice('--click-image='.length)).trim() || null
    continue
  }
  positionalArgs.push(arg)
}

const [traceZip, inputVideo, outputVideo = 'annotated.mp4'] = positionalArgs

if (!traceZip || !inputVideo) {
  console.error('Usage: node scripts/video-script-generator/annotate-video-from-trace.mjs <trace.zip> <video.webm> [output.mp4] [--clip-start-ms=<ms>] [--clip-end-ms=<ms>] [--scenario-xml=<path>] [--intermediate-plan=<path>] [--plan-only]')
  process.exit(1)
}

if (!Number.isFinite(clipStartMs) || clipStartMs < 0) {
  console.error(`Invalid clip start: ${clipStartMs}`)
  process.exit(1)
}
if (clipEndMs !== null && (!Number.isFinite(clipEndMs) || clipEndMs <= clipStartMs)) {
  console.error(`Invalid clip range: ${clipStartMs}..${clipEndMs}`)
  process.exit(1)
}
if (!Number.isFinite(clickBeforeMs) || clickBeforeMs < 0) {
  console.error(`Invalid --click-before-ms: ${clickBeforeMs}`)
  process.exit(1)
}
if (!Number.isFinite(clickAfterMs) || clickAfterMs < 0) {
  console.error(`Invalid --click-after-ms: ${clickAfterMs}`)
  process.exit(1)
}
if (!Number.isFinite(clickFadeMs) || clickFadeMs < 0) {
  console.error(`Invalid --click-fade-ms: ${clickFadeMs}`)
  process.exit(1)
}

if (!existsSync(traceZip)) {
  console.error(`Trace file not found: ${traceZip}`)
  process.exit(1)
}
if (!existsSync(inputVideo)) {
  console.error(`Video file not found: ${inputVideo}`)
  process.exit(1)
}
if (clickImagePath && !existsSync(clickImagePath)) {
  console.error(`Click marker image not found: ${clickImagePath}`)
  process.exit(1)
}
if (scenarioXmlPath && !existsSync(resolve(scenarioXmlPath))) {
  console.error(`Scenario XML not found: ${scenarioXmlPath}`)
  process.exit(1)
}

const clickBeforeSec = clickBeforeMs / 1000
const clickAfterSec = clickAfterMs / 1000
const clickHoldDurationSec = Math.max(0, clickBeforeSec + clickAfterSec)
const clickFadeSec = clickFadeMs / 1000

async function extractTraceEvents(zipPath) {
  const temp = await mkdtemp(join(tmpdir(), 'pw-trace-'))
  try {
    execSync(`unzip -q "${zipPath}" -d "${temp}"`, { stdio: 'inherit' })

    let candidates = ['test.trace', '0-trace.trace']
      .map((name) => join(temp, name))
      .filter((p) => existsSync(p))

    if (!candidates.length) {
      const found = execSync(`find "${temp}" -maxdepth 3 \\( -name "test.trace" -o -name "0-trace.trace" \\)`).toString().trim()
      if (!found) {
        throw new Error('No supported trace file found in zip (expected test.trace or 0-trace.trace).')
      }
      candidates = found.split('\n').filter(Boolean)
    }

    const allRaw = await Promise.all(candidates.map((p) => readFile(p, 'utf8')))
    return allRaw
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function extractStepsAndClicks(events) {
  const steps = []
  const clicks = []
  const started = new Map()
  const pendingClicks = new Map()

  const getEventTimeMs = (entry) => {
    for (const key of ['time', 'startTime', 'endTime']) {
      const value = entry?.[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return null
  }

  for (const entry of events) {
    const method = entry.method ?? ''

    if (entry.type === 'before' && method === 'test.step') {
      started.set(entry.callId, {
        label: entry.title ?? '',
        startMs: entry.startTime,
      })
      continue
    }

    if (entry.type === 'after') {
      const s = started.get(entry.callId)
      if (s) {
        started.delete(entry.callId)
        if (s.startMs !== undefined && entry.endTime !== undefined) {
          steps.push({
            label: s.label,
            startMs: s.startMs,
            endMs: entry.endTime,
          })
        }
      }
      continue
    }

    if (entry.type === 'before' && (method === 'click' || method === 'dblclick' || method === 'tap')) {
      pendingClicks.set(entry.callId, { startMs: entry.startTime })
      continue
    }

    if (entry.type === 'input' && entry.point && entry.callId) {
      const p = pendingClicks.get(entry.callId)
      if (p) {
        const inputTimeMs = getEventTimeMs(entry)
        const clickTimeMs = inputTimeMs !== null ? Math.max(p.startMs, inputTimeMs) : p.startMs
        clicks.push({
          x: Math.round(entry.point.x),
          y: Math.round(entry.point.y),
          tMs: clickTimeMs,
        })
        pendingClicks.delete(entry.callId)
      }
    }
  }

  return { steps, clicks }
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function collectPresentationVideoDirectives(flow, out = []) {
  if (!Array.isArray(flow)) return out
  for (const step of flow) {
    if (!step || typeof step !== 'object') continue
    const stepId = String(step.id || '').trim()
    const pv = step.presentation?.video
    if (stepId && pv && typeof pv === 'object') {
      const start = pv.start == null ? null : String(pv.start).trim().toLowerCase()
      const stop = pv.stop == null ? null : String(pv.stop).trim().toLowerCase()
      if ((start === 'before' || start === 'after') || (stop === 'before' || stop === 'after')) {
        out.push({ stepId, start, stop })
      }
    }
    if (Array.isArray(step.flow)) collectPresentationVideoDirectives(step.flow, out)
  }
  return out
}

function collectChapterCurtains(flow, out = []) {
  if (!Array.isArray(flow)) return out
  for (const step of flow) {
    if (!step || typeof step !== 'object') continue
    const stepId = String(step.id || '').trim()
    if (stepId && step.chapter && typeof step.chapter === 'object') {
      out.push({
        stepId,
        text: String(step.chapter.text || '').trim(),
        durationMs: Math.max(1, Number(step.chapter.duration_ms || step.chapter.durationMs || DEFAULT_CHAPTER_DURATION_MS) || DEFAULT_CHAPTER_DURATION_MS),
        fontSize: Math.max(1, Number(step.chapter.font_size || step.chapter.fontSize || 54) || 54),
      })
    }
    if (Array.isArray(step.flow)) collectChapterCurtains(step.flow, out)
  }
  return out
}

function resolveTraceStepForScenarioId(stepId, traceSteps) {
  const wanted = normalizeToken(stepId)
  if (!wanted) return null

  const matches = traceSteps
    .map((step) => ({ step, token: normalizeToken(step.label) }))
    .filter((entry) => entry.token)
    .filter((entry) => entry.token === wanted || entry.token.includes(wanted) || wanted.includes(entry.token))
    .sort((a, b) => a.token.length - b.token.length)

  return matches.length ? matches[0].step : null
}

function resolveScenarioClipRange(traceSteps, directives) {
  const starts = []
  const stops = []
  const resolved = []

  for (const directive of directives) {
    const window = resolveTraceStepForScenarioId(directive.stepId, traceSteps)
    if (!window) continue

    const resolvedStartMs = directive.start === 'before'
      ? window.startMs
      : directive.start === 'after'
        ? window.endMs
        : null

    const resolvedStopMs = directive.stop === 'before'
      ? window.startMs
      : directive.stop === 'after'
        ? window.endMs
        : null

    if (resolvedStartMs != null) starts.push(resolvedStartMs)
    if (resolvedStopMs != null) stops.push(resolvedStopMs)

    resolved.push({
      ...directive,
      traceLabel: window.label,
      resolvedStartMs,
      resolvedStopMs,
    })
  }

  const startMs = starts.length ? Math.min(...starts) : null
  const endMs = stops.length ? Math.max(...stops) : null

  if (startMs == null && endMs == null) return null
  if (startMs != null && endMs != null && endMs <= startMs) return null

  return { startMs, endMs, resolvedDirectives: resolved }
}

async function readScenarioData(pathValue) {
  if (!pathValue) {
    return {
      scenarioPath: null,
      directives: [],
      chapterCurtains: [],
    }
  }

  const scenarioXmlPathAbsolute = resolve(pathValue)
  const scenarioName = basename(scenarioXmlPathAbsolute, extname(scenarioXmlPathAbsolute))
  const resolvedJsonPath = resolve('temp', 'testfiles', `${scenarioName}.resolved.json`)

  const generateResult = spawnSync('node', [
    'scripts/test-script-generator/generate-tests-from-scenario-xml.mjs',
    scenarioXmlPathAbsolute,
    '--out-dir',
    'temp/testfiles',
  ], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if ((generateResult.status ?? 1) !== 0) {
    throw new Error(`Scenario XML could not be resolved: ${scenarioXmlPathAbsolute}`)
  }

  if (!existsSync(resolvedJsonPath)) {
    throw new Error(`Resolved scenario JSON not found after XML generation: ${resolvedJsonPath}`)
  }

  const raw = await readFile(resolvedJsonPath, 'utf8')
  const parsed = JSON.parse(raw)
  const root = parsed.interaction || parsed
  const flow = Array.isArray(root?.flow) ? root.flow : []

  return {
    scenarioPath: scenarioXmlPathAbsolute,
    scenarioDir: dirname(scenarioXmlPathAbsolute),
    directives: collectPresentationVideoDirectives(flow),
    chapterCurtains: collectChapterCurtains(flow),
  }
}

function toVideoSeconds(steps, clicks, options = {}) {
  const clipStartSec = Math.max(0, Number(options.clipStartMs || 0) / 1000)
  const clipEndSec = options.clipEndMs == null ? null : Number(options.clipEndMs) / 1000

  if (steps.length === 0 && clicks.length === 0) {
    return { segments: [], clickMarkers: [], originMs: null }
  }

  const allMs = [
    ...steps.map((s) => s.startMs),
    ...clicks.map((c) => c.tMs),
  ]
  const origin = Math.min(...allMs)

  const segments = steps
    .map((s) => ({
      label: s.label,
      start: (s.startMs - origin) / 1000,
      end: (s.endMs - origin) / 1000,
    }))
    .map((segment) => ({
      ...segment,
      start: Math.max(0, segment.start - clipStartSec),
      end: (clipEndSec == null ? segment.end : Math.min(segment.end, clipEndSec)) - clipStartSec,
    }))
    .filter((segment) => segment.end > segment.start)

  const clickMarkers = clicks
    .map((c) => ({
      x: c.x,
      y: c.y,
      at: (c.tMs - origin) / 1000,
    }))
    .map((marker) => ({
      ...marker,
      at: marker.at - clipStartSec,
    }))
    .filter((marker) => marker.at >= 0 && (clipEndSec == null || marker.at <= clipEndSec - clipStartSec))

  return { segments, clickMarkers, originMs: origin }
}

function resolveChapterCurtainsToTimeline({ chapterDefinitions, traceSteps, originMs, clipStartMs: clipStart, clipEndMs: clipEnd }) {
  const clipStartSec = Math.max(0, Number(clipStart || 0) / 1000)
  const clipEndSec = clipEnd == null ? null : Math.max(0, Number(clipEnd || 0) / 1000)
  const out = []

  for (const chapter of chapterDefinitions) {
    if (!chapter.text) continue

    const window = resolveTraceStepForScenarioId(chapter.stepId, traceSteps)
    if (!window) continue

    const startSec = ((window.startMs - originMs) / 1000) - clipStartSec
    const durationSec = Math.max(0.001, Number(chapter.durationMs || DEFAULT_CHAPTER_DURATION_MS) / 1000)
    const unclampedEndSec = startSec + durationSec
    const endSec = clipEndSec == null ? unclampedEndSec : Math.min(unclampedEndSec, clipEndSec - clipStartSec)

    if (endSec <= 0 || endSec <= startSec) continue

    out.push({
      stepId: chapter.stepId,
      traceLabel: window.label,
      text: chapter.text,
      fontSize: chapter.fontSize,
      startSec: Math.max(0, startSec),
      endSec,
    })
  }

  return out.sort((a, b) => a.startSec - b.startSec)
}

async function getMediaMetadata(filePath) {
  const { getVideoMetadata } = await import('@remotion/renderer')
  const metadata = await getVideoMetadata(resolve(filePath))
  return {
    durationInSeconds: Number(metadata?.durationInSeconds) || 0,
    width: Number(metadata?.width) || 0,
    height: Number(metadata?.height) || 0,
    fps: Number(metadata?.fps) || 25,
    hasAudio: Boolean(metadata?.audioCodec),
  }
}

async function main() {
  console.log(`Reading trace: ${traceZip}`)
  const traceEvents = await extractTraceEvents(traceZip)
  const { steps, clicks } = extractStepsAndClicks(traceEvents)

  if (!steps.length) {
    console.error('No test.step events found in trace.')
    process.exit(1)
  }

  const scenario = await readScenarioData(scenarioXmlPath)
  const clipFromScenario = resolveScenarioClipRange(steps, scenario.directives)

  let effectiveClipStartMs = clipStartMs
  let effectiveClipEndMs = clipEndMs

  if (!clipStartExplicit && clipFromScenario?.startMs != null) {
    effectiveClipStartMs = Math.max(0, Math.floor(clipFromScenario.startMs))
  }
  if (!clipEndExplicit && clipFromScenario?.endMs != null) {
    effectiveClipEndMs = Math.max(0, Math.floor(clipFromScenario.endMs))
  }

  if (effectiveClipEndMs != null && effectiveClipEndMs <= effectiveClipStartMs) {
    throw new Error(`Invalid effective clip range: ${effectiveClipStartMs}..${effectiveClipEndMs}`)
  }

  const { segments, clickMarkers, originMs } = toVideoSeconds(steps, clicks, {
    clipStartMs: effectiveClipStartMs,
    clipEndMs: effectiveClipEndMs,
  })

  const chapterCurtains = originMs == null
    ? []
    : resolveChapterCurtainsToTimeline({
      chapterDefinitions: scenario.chapterCurtains,
      traceSteps: steps,
      originMs,
      clipStartMs: effectiveClipStartMs,
      clipEndMs: effectiveClipEndMs,
    })

  const effectiveClickMarkers = (clickEnabled && clickHoldDurationSec > 0)
    ? clickMarkers
    : []

  const sourceMedia = await getMediaMetadata(inputVideo)
  if (!Number.isFinite(sourceMedia.durationInSeconds) || sourceMedia.durationInSeconds <= 0) {
    throw new Error(`Could not read media duration via Remotion metadata: ${inputVideo}`)
  }
  if (!Number.isFinite(sourceMedia.width) || !Number.isFinite(sourceMedia.height) || sourceMedia.width <= 0 || sourceMedia.height <= 0) {
    throw new Error(`Could not read video dimensions via Remotion metadata: ${inputVideo}`)
  }

  const baseDurationSec = effectiveClipEndMs != null
    ? (effectiveClipEndMs - effectiveClipStartMs) / 1000
    : Math.max(0.001, sourceMedia.durationInSeconds - (effectiveClipStartMs / 1000))

  const outputFps = Math.max(1, Math.round(Number(sourceMedia.fps) || 25))
  const outputWidth = Math.max(1, Math.round(Number(sourceMedia.width) || 1280))
  const outputHeight = Math.max(1, Math.round(Number(sourceMedia.height) || 720))
  const outputDurationInFrames = Math.max(1, Math.ceil(baseDurationSec * outputFps))

  const plan = {
    generatedAt: new Date().toISOString(),
    inputVideo: resolve(inputVideo),
    traceZip: resolve(traceZip),
    sourceVideo: resolve(inputVideo),
    outputVideo: resolve(outputVideo),
    width: outputWidth,
    height: outputHeight,
    fps: outputFps,
    outputDurationSec: baseDurationSec,
    durationInFrames: outputDurationInFrames,
    narrations: [],
    scenarioYaml: scenario.scenarioPath,
    clip: {
      startMs: effectiveClipStartMs,
      endMs: effectiveClipEndMs,
      source: clipFromScenario ? 'scenario-presentation-video' : 'cli-or-default',
      resolvedDirectives: clipFromScenario?.resolvedDirectives || [],
    },
    click: {
      enabled: clickEnabled,
      beforeMs: clickBeforeMs,
      afterMs: clickAfterMs,
      fadeMs: clickFadeMs,
      holdDurationSec: clickHoldDurationSec,
      image: clickImagePath ? resolve(clickImagePath) : null,
    },
    timeline: {
      originMs,
      baseDurationSec,
      stepSegments: segments,
      chapterCurtains,
      clickMarkers: effectiveClickMarkers,
    },
  }

  const resolvedPlanPath = intermediatePlanPath
    ? resolve(intermediatePlanPath)
    : `${resolve(outputVideo)}.remotion-plan.json`

  await writeFile(resolvedPlanPath, JSON.stringify(plan, null, 2), 'utf8')

  console.log(`Remotion plan written: ${resolvedPlanPath}`)

  const clickHolds = loadedPlanToClickHolds(plan, clickHoldDurationSec)
  const clickHoldDurationMs = clickHolds.reduce((sum, h) => sum + Math.max(0, Number(h.durationMs || 0)), 0)

  await writeFile(getAnnotateMetaPath(outputVideo), JSON.stringify({
    generatedAt: new Date().toISOString(),
    remotionPlanPath: resolvedPlanPath,
    audioHandledInRemotionStage: sourceMedia.hasAudio,
    chapterCurtains: plan.timeline.chapterCurtains,
    clickHoldDurationMs,
    clickHolds,
    planOnly,
  }, null, 2), 'utf8')

  if (!planOnly) {
    console.log('Hinweis: Dieses Skript liefert nur den Plan. Rendering erfolgt zentral ueber run-annotated-video.mjs.')
  }
}

function loadedPlanToClickHolds(loadedPlan, holdDurationSec) {
  return (loadedPlan?.timeline?.clickMarkers || []).map((marker) => ({
    atMs: Math.round(Number(marker.at || 0) * 1000),
    durationMs: Math.round(Math.max(0, Number(holdDurationSec || 0)) * 1000),
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
