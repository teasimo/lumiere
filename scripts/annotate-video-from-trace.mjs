#!/usr/bin/env node
/**
 * Reads a Playwright trace zip, derives test.step timing, builds a Remotion
 * intermediate artifact (plan + script), and then renders the annotated video
 * from that artifact.
 *
 * Usage:
 *   node scripts/annotate-video-from-trace.mjs <trace.zip> <video.webm> [output.mp4]
 *     [--clip-start-ms=<ms>] [--clip-end-ms=<ms>]
 *     [--scenario-xml=<path>] [--intermediate-plan=<path>] [--remotion-script=<path>]
 *     [--plan-only]
 *     [--skip-remotion-script]
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
const DEFAULT_CLICK_MARKER_GLYPH = 'o'
const DEFAULT_CLICK_MARKER_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const DEFAULT_CLICK_MARKER_FONT_SIZE = 72
const DEFAULT_CLICK_MARKER_SIZE_PX = 96
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
let remotionScriptPath = null
let planOnly = false
let skipRemotionScript = false
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
    remotionScriptPath = String(arg.slice('--remotion-script='.length)).trim() || null
    continue
  }
  if (arg === '--plan-only') {
    planOnly = true
    continue
  }
  if (arg === '--skip-remotion-script') {
    skipRemotionScript = true
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
  console.error('Usage: node annotate-video-from-trace.mjs <trace.zip> <video.webm> [output.mp4] [--clip-start-ms=<ms>] [--clip-end-ms=<ms>] [--scenario-xml=<path>] [--intermediate-plan=<path>] [--remotion-script=<path>]')
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
    'scripts/generate-tests-from-scenario-xml.mjs',
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

function getMediaDurationSeconds(filePath) {
  const output = execSync(
    `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${filePath}"`
  ).toString().trim()

  const duration = Number.parseFloat(output)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read media duration: ${filePath}`)
  }
  return duration
}

function getVideoDimensions(filePath) {
  const output = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${filePath}"`
  ).toString().trim()

  const [wRaw, hRaw] = output.split('x')
  const width = Number.parseInt(wRaw, 10)
  const height = Number.parseInt(hRaw, 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Could not read video dimensions: ${filePath}`)
  }
  return { width, height }
}

function hasAudioStream(filePath) {
  const output = execSync(
    `ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "${filePath}" || true`
  ).toString().trim()
  return Boolean(output)
}

function runFfmpegOrThrow(args) {
  const ffmpegResult = spawnSync('ffmpeg', args, {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
  })

  if (ffmpegResult.error) throw ffmpegResult.error
  if ((ffmpegResult.status ?? 1) !== 0) {
    const signal = ffmpegResult.signal ? `, signal ${ffmpegResult.signal}` : ''
    const stderr = String(ffmpegResult.stderr || '').trim()
    const stderrTail = stderr ? `\nffmpeg stderr (tail):\n${stderr.split('\n').slice(-20).join('\n')}` : ''
    throw new Error(`ffmpeg failed with exit code ${ffmpegResult.status ?? 1}${signal}${stderrTail}`)
  }
}

function escapeDrawText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
}

function renderDefaultClickMarkerImage({ outputPath, sizePx, glyph, fontPath, fontSize }) {
  const escapedGlyph = escapeDrawText(glyph)
  const vf = [
    'format=rgba',
    'colorchannelmixer=aa=0',
    `drawtext=text='${escapedGlyph}':fontfile=${fontPath}:fontsize=${fontSize}:fontcolor=yellow@1:borderw=3:bordercolor=black@1:x=(w-text_w)/2:y=(h-text_h)/2`,
  ].join(',')

  runFfmpegOrThrow([
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=black@0.0:s=${sizePx}x${sizePx}:d=0.1`,
    '-frames:v', '1',
    '-vf', vf,
    outputPath,
  ])
}

function buildBaseFilter({ stepSegments, chapterCurtains }) {
  const filters = []

  const flatSegments = []
  if (stepSegments.length > 0) {
    const times = new Set()
    for (const s of stepSegments) {
      times.add(s.start)
      times.add(s.end)
    }
    const sorted = [...times].sort((a, b) => a - b)

    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const t0 = sorted[i]
      const t1 = sorted[i + 1]
      const mid = (t0 + t1) / 2
      const active = stepSegments.filter((s) => s.start <= mid && s.end >= t1)
      if (!active.length) continue
      const deepest = active[active.length - 1]
      if (flatSegments.length > 0 && flatSegments[flatSegments.length - 1].label === deepest.label) {
        flatSegments[flatSegments.length - 1].end = t1
      } else {
        flatSegments.push({ label: deepest.label, start: t0, end: t1 })
      }
    }
  }

  for (const s of flatSegments) {
    const t = `gte(t,${s.start.toFixed(3)})*lt(t,${s.end.toFixed(3)})`
    filters.push([
      `drawtext=text='${escapeDrawText(s.label)}'`,
      `enable='${t}'`,
      'fontsize=22',
      'fontcolor=white',
      'box=1',
      'boxcolor=black@0.6',
      'boxborderw=6',
      'x=16',
      'y=16',
      'fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ].join(':'))
  }

  for (const chapter of chapterCurtains) {
    const start = Math.max(0, Number(chapter.startSec || 0))
    const end = Math.max(start, Number(chapter.endSec || 0))
    if (!(end > start + 0.001)) continue

    const lines = String(chapter.text || '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    if (!lines.length) continue

    const enableExpr = `gte(t,${start.toFixed(3)})*lt(t,${end.toFixed(3)})`
    const fontSize = Math.max(16, Number(chapter.fontSize || 54) || 54)
    const lineSpacing = Math.max(22, Math.round(fontSize * 1.2))

    filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@0.62:t=fill:enable='${enableExpr}'`)

    const centerOffset = ((lines.length - 1) * lineSpacing) / 2
    for (let i = 0; i < lines.length; i += 1) {
      filters.push([
        `drawtext=text='${escapeDrawText(lines[i])}'`,
        `enable='${enableExpr}'`,
        `fontsize=${fontSize}`,
        'fontcolor=white',
        'box=0',
        'x=(w-text_w)/2',
        `y=(h/2)-${centerOffset.toFixed(3)}+${(i * lineSpacing).toFixed(3)}`,
        'fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      ].join(':'))
    }
  }

  if (!filters.length) return '[0:v]null[vout]'
  return `[0:v]${filters.join(',')}[vout]`
}

function renderBaseAnnotatedVideo({ sourceVideo, outputPath, clipStart, clipEnd, filterComplex, includeAudio }) {
  const clipArgs = []
  if (clipStart > 0) clipArgs.push('-ss', (clipStart / 1000).toFixed(3))
  if (clipEnd != null) clipArgs.push('-to', (clipEnd / 1000).toFixed(3))

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    ...clipArgs,
    '-i', sourceVideo,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'fast',
    '-pix_fmt', 'yuv420p',
  ]

  if (includeAudio) {
    args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '192k')
  }

  args.push(outputPath)

  console.log(`ffmpeg ${args.map((a) => JSON.stringify(a)).join(' ')}`)
  runFfmpegOrThrow(args)
}

function insertSingleClickFreezeIntoVideo({
  inputFile,
  outputFile,
  tempDir,
  clickIndex,
  clickAtSec,
  holdDurationSec,
  x,
  y,
  markerImagePath,
  markerSizePx,
  markerFadeSec,
  includeAudio,
}) {
  const videoDuration = getMediaDurationSeconds(inputFile)
  const { width, height } = getVideoDimensions(inputFile)
  const atSec = Math.min(videoDuration, Math.max(0, Number(clickAtSec) || 0))
  const holdSec = Math.max(0.001, Number(holdDurationSec) || 0)
  const framePath = join(tempDir, `click-freeze-${clickIndex}.png`)

  runFfmpegOrThrow([
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', atSec.toFixed(3),
    '-i', inputFile,
    '-frames:v', '1',
    framePath,
  ])

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputFile,
    '-loop', '1', '-i', framePath,
    '-loop', '1', '-i', markerImagePath,
  ]

  const filterParts = []
  const concatV = []
  const concatA = []

  if (includeAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  }

  if (atSec > 0.001) {
    filterParts.push(`[0:v]trim=start=0:end=${atSec.toFixed(3)},setpts=PTS-STARTPTS[vbefore]`)
    concatV.push('[vbefore]')
    if (includeAudio) {
      filterParts.push(`[0:a]atrim=start=0:end=${atSec.toFixed(3)},asetpts=PTS-STARTPTS[abefore]`)
      concatA.push('[abefore]')
    }
  }

  filterParts.push(
    `[1:v]trim=start=0:end=${holdSec.toFixed(3)},setpts=PTS-STARTPTS,` +
    `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[vfreezebase]`
  )

  const fadeInSec = Math.min(markerFadeSec, holdSec / 2)
  const fadeOutSec = Math.min(markerFadeSec, Math.max(0, holdSec - fadeInSec))
  const fadeOutStart = Math.max(0, holdSec - fadeOutSec)

  filterParts.push(
    `[2:v]trim=start=0:end=${holdSec.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
    `scale=w=${markerSizePx}:h=${markerSizePx}:force_original_aspect_ratio=decrease` +
    `${fadeInSec > 0 ? `,fade=t=in:st=0:d=${fadeInSec.toFixed(3)}:alpha=1` : ''}` +
    `${fadeOutSec > 0 ? `,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSec.toFixed(3)}:alpha=1` : ''}` +
    '[vmarker]'
  )

  filterParts.push('[vfreezebase][vmarker]overlay=x=' + `${x}` + '-overlay_w/2:y=' + `${y}` + '-overlay_h/2:eof_action=pass[vfreeze]')
  concatV.push('[vfreeze]')

  if (includeAudio) {
    filterParts.push(`[3:a]atrim=start=0:end=${holdSec.toFixed(3)},asetpts=PTS-STARTPTS[asilence]`)
    concatA.push('[asilence]')
  }

  if (videoDuration > atSec + 0.001) {
    filterParts.push(`[0:v]trim=start=${atSec.toFixed(3)}:end=${videoDuration.toFixed(3)},setpts=PTS-STARTPTS[vafter]`)
    concatV.push('[vafter]')
    if (includeAudio) {
      filterParts.push(`[0:a]atrim=start=${atSec.toFixed(3)}:end=${videoDuration.toFixed(3)},asetpts=PTS-STARTPTS[aafter]`)
      concatA.push('[aafter]')
    }
  }

  if (concatV.length === 1) {
    filterParts.push(`${concatV[0]}null[vout]`)
  } else {
    filterParts.push(`${concatV.join('')}concat=n=${concatV.length}:v=1:a=0[vout]`)
  }

  if (includeAudio) {
    if (concatA.length === 1) {
      filterParts.push(`${concatA[0]}anull[aout]`)
    } else {
      filterParts.push(`${concatA.join('')}concat=n=${concatA.length}:v=0:a=1[aout]`)
    }
  }

  args.push('-filter_complex', filterParts.join(';'))
  args.push('-map', '[vout]')
  if (includeAudio) args.push('-map', '[aout]')

  args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p')
  if (includeAudio) args.push('-c:a', 'aac', '-b:a', '192k')
  args.push(outputFile)

  console.log(`ffmpeg ${args.map((a) => JSON.stringify(a)).join(' ')}`)
  runFfmpegOrThrow(args)
}

function buildRemotionTsxScript(plan) {
  const sourceVideo = String(plan?.sourceVideo || '')
  const segments = Array.isArray(plan?.timeline?.stepSegments) ? plan.timeline.stepSegments : []
  const chapterCurtains = Array.isArray(plan?.timeline?.chapterCurtains) ? plan.timeline.chapterCurtains : []
  const clickMarkers = Array.isArray(plan?.timeline?.clickMarkers) ? plan.timeline.clickMarkers : []
  const clickHoldDurationSec = Math.max(0, Number(plan?.click?.holdDurationSec || 0))

  const normalizedSteps = segments
    .map((segment, index) => {
      const label = String(segment?.label || `step-${index + 1}`)
      const startSec = Math.max(0, Number(segment?.start || 0))
      const endSec = Math.max(startSec + 0.001, Number(segment?.end || startSec + 0.001))
      return {
        label,
        startSec,
        endSec,
        durationSec: Math.max(0.001, endSec - startSec),
      }
    })

  const epsilon = 0.001
  let accumulatedFrames = 0
  const storyboardSteps = normalizedSteps.map((step, index) => {
    const stepStartFrame = accumulatedFrames
    const stepDurationFrames = Math.max(1, Math.round(step.durationSec * 25))
    accumulatedFrames += stepDurationFrames

    const curtainsForStep = chapterCurtains
      .filter((curtain) => {
        const startSec = Number(curtain?.startSec || 0)
        return startSec >= (step.startSec - epsilon) && startSec < (step.endSec + epsilon)
      })
      .map((curtain) => {
        const curtainStartSec = Math.max(step.startSec, Number(curtain?.startSec || step.startSec))
        const curtainEndSec = Math.max(curtainStartSec + 0.001, Number(curtain?.endSec || curtainStartSec + 0.001))
        return {
          text: String(curtain?.text || ''),
          fontSize: Math.max(1, Number(curtain?.fontSize || 54)),
          localFromFrames: Math.max(0, Math.round((curtainStartSec - step.startSec) * 25)),
          durationFrames: Math.max(1, Math.round((curtainEndSec - curtainStartSec) * 25)),
        }
      })

    const clicksForStep = clickMarkers
      .filter((marker) => {
        const markerSec = Number(marker?.at || 0)
        return markerSec >= (step.startSec - epsilon) && markerSec < (step.endSec + epsilon)
      })
      .map((marker) => ({
        x: Math.round(Number(marker?.x || 0)),
        y: Math.round(Number(marker?.y || 0)),
        localFromFrames: Math.max(0, Math.round((Math.max(step.startSec, Number(marker?.at || step.startSec)) - step.startSec) * 25)),
        durationFrames: Math.max(1, Math.round(clickHoldDurationSec * 25)),
      }))

    return {
      index,
      label: step.label,
      clipStartFrame: Math.max(0, Math.round(step.startSec * 25)),
      clipEndFrame: Math.max(1, Math.round(step.endSec * 25)),
      fromFrame: stepStartFrame,
      durationFrames: stepDurationFrames,
      curtains: curtainsForStep,
      clicks: clicksForStep,
    }
  })

  const lines = [
    '// Generated by scripts/annotate-video-from-trace.mjs',
    '// Storyboard-style Remotion TSX: each scenario step is rendered as an explicit local block.',
    '',
    "import React from 'react'",
    "import { AbsoluteFill, Sequence, Video, staticFile } from 'remotion'",
    '',
    `const SOURCE_VIDEO = ${JSON.stringify(sourceVideo)}`,
    '',
    'function StepLabel({ text }: { text: string }) {',
    '  return (',
    '    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start", padding: 16, pointerEvents: "none" }}>',
    '      <div style={{ color: "white", backgroundColor: "rgba(0,0,0,0.62)", padding: "6px 10px", borderRadius: 6, fontSize: 20, fontFamily: "DejaVu Sans, sans-serif" }}>',
    '        {text}',
    '      </div>',
    '    </AbsoluteFill>',
    '  )',
    '}',
    '',
    'function CurtainOverlay({ text, fontSize }: { text: string, fontSize: number }) {',
    '  const lines = String(text || "")',
    '    .split("\\n")',
    '    .map((line) => line.trim())',
    '    .filter(Boolean)',
    '  return (',
    '    <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.62)", justifyContent: "center", alignItems: "center", padding: 32 }}>',
    '      <div style={{ color: "white", fontWeight: 700, fontFamily: "DejaVu Sans, sans-serif", fontSize, textAlign: "center", lineHeight: 1.2 }}>',
    '        {lines.length > 0 ? lines.map((line, index) => <div key={index}>{line}</div>) : null}',
    '      </div>',
    '    </AbsoluteFill>',
    '  )',
    '}',
    '',
    'function ClickMarker({ x, y }: { x: number, y: number }) {',
    '  return (',
    '    <AbsoluteFill style={{ pointerEvents: "none" }}>',
    '      <div style={{ position: "absolute", left: x - 28, top: y - 28, width: 56, height: 56, borderRadius: 999, border: "5px solid rgba(255,255,255,0.95)", boxShadow: "0 0 0 10px rgba(0,0,0,0.24)", backgroundColor: "rgba(255,255,255,0.12)" }} />',
    '    </AbsoluteFill>',
    '  )',
    '}',
    '',
    'export const AnnotatedRemotionComposition: React.FC = () => {',
    '  return (',
    '    <AbsoluteFill style={{ backgroundColor: "black" }}>',
  ]

  if (storyboardSteps.length === 0) {
    lines.push('      <Video src={staticFile(SOURCE_VIDEO)} />')
  } else {
    for (const step of storyboardSteps) {
      lines.push('')
      lines.push(`      {/* Step ${step.index + 1}: ${step.label} */}`)
      lines.push(`      <Sequence from={${step.fromFrame}} durationInFrames={${step.durationFrames}}>`) 
      lines.push('        <AbsoluteFill>')
      lines.push(`          <Video src={staticFile(SOURCE_VIDEO)} startFrom={${step.clipStartFrame}} endAt={${step.clipEndFrame}} />`)
      lines.push(`          <StepLabel text=${JSON.stringify(step.label)} />`)

      for (const curtain of step.curtains) {
        lines.push(`          <Sequence from={${curtain.localFromFrames}} durationInFrames={${curtain.durationFrames}}>`)
        lines.push(`            <CurtainOverlay text=${JSON.stringify(curtain.text)} fontSize={${curtain.fontSize}} />`)
        lines.push('          </Sequence>')
      }

      for (const marker of step.clicks) {
        lines.push(`          <Sequence from={${marker.localFromFrames}} durationInFrames={${marker.durationFrames}}>`)
        lines.push(`            <ClickMarker x={${marker.x}} y={${marker.y}} />`)
        lines.push('          </Sequence>')
      }

      lines.push('        </AbsoluteFill>')
      lines.push('      </Sequence>')
    }
  }

  lines.push('    </AbsoluteFill>')
  lines.push('  )')
  lines.push('}')
  lines.push('')
  lines.push('export default AnnotatedRemotionComposition')
  lines.push('')

  return lines.join('\n')
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

  const baseDurationSec = effectiveClipEndMs != null
    ? (effectiveClipEndMs - effectiveClipStartMs) / 1000
    : Math.max(0.001, getMediaDurationSeconds(inputVideo) - (effectiveClipStartMs / 1000))

  const plan = {
    generatedAt: new Date().toISOString(),
    traceZip: resolve(traceZip),
    sourceVideo: resolve(inputVideo),
    outputVideo: resolve(outputVideo),
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
  const resolvedRemotionScriptPath = skipRemotionScript
    ? null
    : (remotionScriptPath
      ? resolve(remotionScriptPath)
      : `${resolve(outputVideo)}.remotion.tsx`)

  await writeFile(resolvedPlanPath, JSON.stringify(plan, null, 2), 'utf8')
  if (resolvedRemotionScriptPath) {
    await writeFile(resolvedRemotionScriptPath, buildRemotionTsxScript(plan), 'utf8')
  }

  console.log(`Remotion plan written: ${resolvedPlanPath}`)
  if (resolvedRemotionScriptPath) {
    console.log(`Remotion script written: ${resolvedRemotionScriptPath}`)
  }

  const clickHolds = loadedPlanToClickHolds(plan, clickHoldDurationSec)
  const clickHoldDurationMs = clickHolds.reduce((sum, h) => sum + Math.max(0, Number(h.durationMs || 0)), 0)

  await writeFile(getAnnotateMetaPath(outputVideo), JSON.stringify({
    generatedAt: new Date().toISOString(),
    remotionPlanPath: resolvedPlanPath,
    remotionScriptPath: resolvedRemotionScriptPath,
    audioHandledInRemotionStage: hasAudioStream(inputVideo),
    chapterCurtains: plan.timeline.chapterCurtains,
    clickHoldDurationMs,
    clickHolds,
    planOnly,
  }, null, 2), 'utf8')

  if (planOnly) {
    console.log('Plan-only mode: Rendering wurde uebersprungen, nur Plan/TSX/Meta erstellt.')
    return
  }

  const loadedPlan = JSON.parse(await readFile(resolvedPlanPath, 'utf8'))
  const includeAudio = hasAudioStream(inputVideo)

  const tempDir = await mkdtemp(join(tmpdir(), 'annotate-remotion-'))
  try {
    const baseVideo = loadedPlan.timeline.clickMarkers.length > 0
      ? join(tempDir, 'base-annotated.mp4')
      : outputVideo

    console.log('Rendering base annotated timeline from Remotion plan...')
    renderBaseAnnotatedVideo({
      sourceVideo: inputVideo,
      outputPath: baseVideo,
      clipStart: loadedPlan.clip.startMs,
      clipEnd: loadedPlan.clip.endMs,
      filterComplex: buildBaseFilter({
        stepSegments: loadedPlan.timeline.stepSegments,
        chapterCurtains: loadedPlan.timeline.chapterCurtains,
      }),
      includeAudio,
    })

    if (loadedPlan.timeline.clickMarkers.length > 0) {
      const markerImage = clickImagePath || join(tempDir, 'default-click-marker.png')
      if (!clickImagePath) {
        renderDefaultClickMarkerImage({
          outputPath: markerImage,
          sizePx: DEFAULT_CLICK_MARKER_SIZE_PX,
          glyph: DEFAULT_CLICK_MARKER_GLYPH,
          fontPath: DEFAULT_CLICK_MARKER_FONT,
          fontSize: DEFAULT_CLICK_MARKER_FONT_SIZE,
        })
      }

      let currentInput = baseVideo
      let insertedSec = 0
      for (let i = 0; i < loadedPlan.timeline.clickMarkers.length; i += 1) {
        const marker = loadedPlan.timeline.clickMarkers[i]
        const isLast = i === loadedPlan.timeline.clickMarkers.length - 1
        const targetOutput = isLast ? outputVideo : join(tempDir, `click-pass-${i + 1}.mp4`)

        insertSingleClickFreezeIntoVideo({
          inputFile: currentInput,
          outputFile: targetOutput,
          tempDir,
          clickIndex: i + 1,
          clickAtSec: Math.max(0, Number(marker.at || 0) + insertedSec),
          holdDurationSec: clickHoldDurationSec,
          x: Math.round(Number(marker.x || 0)),
          y: Math.round(Number(marker.y || 0)),
          markerImagePath: markerImage,
          markerSizePx: DEFAULT_CLICK_MARKER_SIZE_PX,
          markerFadeSec: clickFadeSec,
          includeAudio,
        })

        currentInput = targetOutput
        insertedSec += clickHoldDurationSec
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  console.log(`Annotated video saved: ${outputVideo}`)
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
