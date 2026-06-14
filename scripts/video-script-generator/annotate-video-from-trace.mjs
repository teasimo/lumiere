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
import { buildScenarioXmlGeneratorInvocation } from '../shared/scenario-xml-generator.mjs'

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

    const allRaw = await Promise.all(candidates.map(async (p) => ({
      name: basename(p),
      raw: await readFile(p, 'utf8'),
    })))

    const events = []
    for (const file of allRaw) {
      for (const line of file.raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = JSON.parse(trimmed)
        parsed.__traceSource = file.name
        events.push(parsed)
      }
    }
    return events
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[middle]
  }
  return (sorted[middle - 1] + sorted[middle]) / 2
}

function resolveBrowserTraceOffsetMs(events) {
  const apiStartByStepId = new Map()
  for (const entry of events) {
    if (entry?.__traceSource !== 'test.trace') continue
    if (entry?.type !== 'before') continue
    const stepId = String(entry?.stepId || '').trim()
    const startTime = Number(entry?.startTime)
    if (!stepId || !Number.isFinite(startTime)) continue
    if (!apiStartByStepId.has(stepId)) {
      apiStartByStepId.set(stepId, startTime)
    }
  }

  const deltas = []
  for (const entry of events) {
    if (entry?.__traceSource !== '0-trace.trace') continue
    if (entry?.type !== 'before') continue
    const stepId = String(entry?.stepId || '').trim()
    const startTime = Number(entry?.startTime)
    const apiStartTime = Number(apiStartByStepId.get(stepId))
    if (!stepId || !Number.isFinite(startTime) || !Number.isFinite(apiStartTime)) continue
    deltas.push(startTime - apiStartTime)
  }

  return median(deltas) || 0
}

function normalizeTraceTimeMs(entry, key, browserTraceOffsetMs) {
  const raw = Number(entry?.[key])
  if (!Number.isFinite(raw)) {
    return null
  }
  if (entry?.__traceSource === '0-trace.trace') {
    return raw - browserTraceOffsetMs
  }
  return raw
}

function resolveTraceViewport(events) {
  for (const entry of events) {
    if (entry?.__traceSource !== '0-trace.trace') continue
    if (String(entry?.type || '').trim().toLowerCase() !== 'context-options') continue

    const viewport = entry?.options?.viewport
    const width = Number(viewport?.width)
    const height = Number(viewport?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      continue
    }

    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    }
  }

  return null
}

function extractStepsAndClicks(events) {
  const steps = []
  const clicks = []
  const started = new Map()
  const pendingClicks = new Map()
  const browserTraceOffsetMs = resolveBrowserTraceOffsetMs(events)

  const getEventTimeMs = (entry) => {
    for (const key of ['startTime', 'time', 'endTime']) {
      const value = normalizeTraceTimeMs(entry, key, browserTraceOffsetMs)
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return null
  }

  for (const entry of events) {
    const method = entry.method ?? ''

    if (entry.type === 'before' && method === 'test.step') {
      started.set(entry.callId, {
        label: entry.title ?? '',
        startMs: getEventTimeMs(entry),
      })
      continue
    }

    if (entry.type === 'after') {
      const s = started.get(entry.callId)
      if (s) {
        started.delete(entry.callId)
        const endMs = getEventTimeMs(entry)
        if (s.startMs !== undefined && endMs !== null) {
          steps.push({
            label: s.label,
            startMs: s.startMs,
            endMs,
          })
        }
      }
      continue
    }

    if (entry.type === 'before' && (method === 'click' || method === 'dblclick' || method === 'tap')) {
      pendingClicks.set(entry.callId, { startMs: getEventTimeMs(entry) })
      continue
    }

    if (entry.type === 'input' && entry.point && entry.callId) {
      const p = pendingClicks.get(entry.callId)
      if (p) {
        const inputTimeMs = getEventTimeMs(entry)
        // Prefer the earliest reliable action timestamp from the pointer event itself.
        // Using the later value shifts markers visibly behind the actual click in the video.
        const clickTimeMs = inputTimeMs !== null ? inputTimeMs : p.startMs
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

function clampCoordinate(value, maxExclusive) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 0
  }

  if (!Number.isFinite(maxExclusive) || maxExclusive <= 1) {
    return Math.max(0, Math.round(numeric))
  }

  return Math.min(Math.max(0, Math.round(numeric)), Math.max(0, Math.floor(maxExclusive) - 1))
}

function scaleClicksToVideo(clicks, traceViewport, videoSize) {
  const viewportWidth = Number(traceViewport?.width)
  const viewportHeight = Number(traceViewport?.height)
  const videoWidth = Number(videoSize?.width)
  const videoHeight = Number(videoSize?.height)

  if (
    !Number.isFinite(viewportWidth) || viewportWidth <= 0
    || !Number.isFinite(viewportHeight) || viewportHeight <= 0
    || !Number.isFinite(videoWidth) || videoWidth <= 0
    || !Number.isFinite(videoHeight) || videoHeight <= 0
  ) {
    return Array.isArray(clicks) ? clicks.map((click) => ({ ...click })) : []
  }

  const scaleX = videoWidth / viewportWidth
  const scaleY = videoHeight / viewportHeight

  return (Array.isArray(clicks) ? clicks : []).map((click) => ({
    ...click,
    x: clampCoordinate(Number(click?.x || 0) * scaleX, videoWidth),
    y: clampCoordinate(Number(click?.y || 0) * scaleY, videoHeight),
  }))
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
  const generatorInvocation = buildScenarioXmlGeneratorInvocation({
    scenarioPath: scenarioXmlPathAbsolute,
    outDir: 'temp/testfiles',
  })

  const generateResult = spawnSync(generatorInvocation.command, generatorInvocation.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if ((generateResult.status ?? 1) !== 0) {
    throw new Error(`Scenario XML could not be resolved: ${scenarioXmlPathAbsolute}`)
  }

  if (!existsSync(generatorInvocation.paths.resolvedJsonPath)) {
    throw new Error(`Resolved scenario JSON not found after XML generation: ${generatorInvocation.paths.resolvedJsonPath}`)
  }

  const raw = await readFile(generatorInvocation.paths.resolvedJsonPath, 'utf8')
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
  const traceViewport = resolveTraceViewport(traceEvents)
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
  const scaledClicks = scaleClicksToVideo(clicks, traceViewport, {
    width: outputWidth,
    height: outputHeight,
  })
  const { segments, clickMarkers, originMs } = toVideoSeconds(steps, scaledClicks, {
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
      traceViewport,
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
