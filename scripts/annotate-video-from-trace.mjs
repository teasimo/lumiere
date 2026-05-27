#!/usr/bin/env node
/**
 * Liest eine Playwright-Trace-ZIP-Datei, extrahiert test.step-Zeitstempel
 * und erstellt ein annotiertes Video mit ffmpeg (drawtext-Overlays).
 *
 * Verwendung:
 *   node scripts/annotate-video-from-trace.mjs <trace.zip> <video.webm> [output.mp4] [--clip-start-ms=<ms>] [--clip-end-ms=<ms>]
 *
 * Voraussetzungen:
 *   - ffmpeg muss im PATH verfügbar sein
 *   - Node.js >= 18
 */

import { existsSync } from 'fs'
import { readFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync, spawnSync } from 'child_process'

// Click marker behavior defaults. Can be overridden via CLI flags.
const DEFAULT_CLICK_BEFORE_MS = 80
const DEFAULT_CLICK_AFTER_MS = 420
const DEFAULT_CLICK_FADE_MS = 0
const DEFAULT_CLICK_MARKER_GLYPH = '○'
const DEFAULT_CLICK_MARKER_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const DEFAULT_CLICK_MARKER_FONT_SIZE = 72
const DEFAULT_CLICK_MARKER_SIZE_PX = 96

function getAnnotateMetaPath(filePath) {
  // Sidecar metadata file used by downstream scripts to keep audio/video timing aligned
  // (for example, when TTS narration also needs to account for inserted click holds).
  return `${filePath}.annotate-meta.json`
}

// --- Argument parsing ---
const rawArgs = process.argv.slice(2)
const positionalArgs = []
let clipStartMs = 0
let clipEndMs = null
let clickEnabled = true
let clickBeforeMs = DEFAULT_CLICK_BEFORE_MS
let clickAfterMs = DEFAULT_CLICK_AFTER_MS
let clickFadeMs = DEFAULT_CLICK_FADE_MS
let clickImagePath = null

// Keep argument parsing intentionally simple:
// - Known options are consumed
// - Remaining positional args map to trace/input/output paths
for (const arg of rawArgs) {
  if (arg.startsWith('--clip-start-ms=')) {
    clipStartMs = Number.parseInt(arg.slice('--clip-start-ms='.length), 10)
    continue
  }
  if (arg.startsWith('--clip-end-ms=')) {
    clipEndMs = Number.parseInt(arg.slice('--clip-end-ms='.length), 10)
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
  console.error('Verwendung: node annotate-video-from-trace.mjs <trace.zip> <video.webm> [output.mp4] [--clip-start-ms=<ms>] [--clip-end-ms=<ms>]')
  process.exit(1)
}

if (!Number.isFinite(clipStartMs) || clipStartMs < 0) {
  console.error(`Ungueltiger Clip-Start: ${clipStartMs}`)
  process.exit(1)
}

if (clipEndMs !== null && (!Number.isFinite(clipEndMs) || clipEndMs <= clipStartMs)) {
  console.error(`Ungueltiger Clip-Bereich: ${clipStartMs}..${clipEndMs}`)
  process.exit(1)
}

if (!Number.isFinite(clickBeforeMs) || clickBeforeMs < 0) {
  console.error(`Ungueltiger Wert fuer --click-before-ms: ${clickBeforeMs}`)
  process.exit(1)
}

if (!Number.isFinite(clickAfterMs) || clickAfterMs < 0) {
  console.error(`Ungueltiger Wert fuer --click-after-ms: ${clickAfterMs}`)
  process.exit(1)
}

if (!Number.isFinite(clickFadeMs) || clickFadeMs < 0) {
  console.error(`Ungueltiger Wert fuer --click-fade-ms: ${clickFadeMs}`)
  process.exit(1)
}

if (clickImagePath && !existsSync(clickImagePath)) {
  console.error(`Klick-Indikator-Bild nicht gefunden: ${clickImagePath}`)
  process.exit(1)
}

const clickBeforeSec = clickBeforeMs / 1000
const clickAfterSec = clickAfterMs / 1000
const clickHoldDurationSec = Math.max(0, clickBeforeSec + clickAfterSec)
const clickFrameLeadSec = clickBeforeSec
const clickFadeSec = clickFadeMs / 1000

if (!existsSync(traceZip)) {
  console.error(`Trace-Datei nicht gefunden: ${traceZip}`)
  process.exit(1)
}

if (!existsSync(inputVideo)) {
  console.error(`Video-Datei nicht gefunden: ${inputVideo}`)
  process.exit(1)
}

// --- Trace entpacken und relevante NDJSON-Datei lesen ---
// Playwright traces are NDJSON-like streams. Depending on PW version/layout,
// relevant events may be spread across different files (`test.trace`, `0-trace.trace`).
// We load all known candidates and merge them into one event stream.
async function extractTraceEvents(zipPath) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'pw-trace-'))
  try {
    execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`, { stdio: 'inherit' })

    let candidates = ['test.trace', '0-trace.trace']
      .map((name) => join(tmpDir, name))
      .filter((path) => existsSync(path))

    if (!candidates.length) {
      // Fallback search for traces in nested folders (some CI artifacts differ)
      const found = execSync(`find "${tmpDir}" -maxdepth 3 \( -name "test.trace" -o -name "0-trace.trace" \)`).toString().trim()
      if (!found) throw new Error('Keine unterstützte Trace-Datei in der ZIP gefunden (erwartet: test.trace oder 0-trace.trace).')
      candidates = found.split('\n').filter(Boolean)
    }

    // Merge all trace files into one parse pass:
    // - `test.trace` typically carries test.step before/after events
    // - `0-trace.trace` often carries raw input coordinates/timing
    const allRaw = await Promise.all(candidates.map(p => readFile(p, 'utf8')))
    const combined = allRaw.join('\n')

    return combined
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// --- Schritte und Klick-Events mit Zeitstempeln extrahieren ---
// We derive two timelines from raw events:
// 1) step segments (start/end) for top-left label overlays
// 2) click points (x/y/time) for temporary click marker overlays
function extractStepsAndClicks(events) {
  const steps = []
  const clicks = []
  const startedSteps = new Map()
  // Pending click state keyed by callId:
  // before(click) provides a stable start time, input event provides coordinates.
  const pendingClicks = new Map()

  // Different trace versions expose timing in different fields.
  // We try a small fallback chain for robustness.
  const getEventTimeMs = (entry) => {
    for (const key of ['time', 'startTime', 'endTime']) {
      const value = entry?.[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
    }
    return null
  }

  for (const entry of events) {
    const title = entry.title ?? ''
    const method = entry.method ?? ''

    if (entry.type === 'before' && method === 'test.step') {
      // Start of a named Playwright test step
      startedSteps.set(entry.callId, {
        label: title,
        startMs: entry.startTime,
      })
      continue
    }

    if (entry.type === 'after') {
      // End of step execution: pair with its matching `before`
      const started = startedSteps.get(entry.callId)
      if (started) {
        startedSteps.delete(entry.callId)
        if (started.startMs !== undefined && entry.endTime !== undefined) {
          steps.push({
            label: started.label,
            startMs: started.startMs,
            endMs: entry.endTime,
          })
        }
      }
      continue
    }

    // before-event for click-like methods: store tentative timestamp anchor
    if (entry.type === 'before' && (method === 'click' || method === 'dblclick' || method === 'tap')) {
      pendingClicks.set(entry.callId, { startMs: entry.startTime })
      continue
    }

    // input-event contains actual pointer coordinates; match via callId
    if (entry.type === 'input' && entry.point && entry.callId) {
      const pending = pendingClicks.get(entry.callId)
      if (pending) {
        // Use max(before.start, input.time) to avoid negative ordering artifacts
        const inputTimeMs = getEventTimeMs(entry)
        const clickTimeMs = inputTimeMs !== null ? Math.max(pending.startMs, inputTimeMs) : pending.startMs
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

// --- Zeitstempel auf Video-Sekunden umrechnen ---
// We normalize all trace timestamps to a shared origin (= earliest event), then
// apply clip start/end slicing. Result is a clip-relative timeline in seconds.
function toVideoSeconds(steps, clicks, options = {}) {
  const clipStartSec = Math.max(0, Number(options.clipStartMs || 0) / 1000)
  const clipEndSec = options.clipEndMs == null ? null : Number(options.clipEndMs) / 1000
  if (steps.length === 0 && clicks.length === 0) return { segments: [], clickMarkers: [] }
  // Shared origin: earliest event across steps/clicks
  const allMs = [
    ...steps.map(s => s.startMs),
    ...clicks.map(c => c.tMs),
  ]
  const origin = Math.min(...allMs)

  const segments = steps
    .map(s => ({
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
    .map(c => ({
      x: c.x,
      y: c.y,
      at: (c.tMs - origin) / 1000,
    }))
    .map((marker) => ({
      ...marker,
      at: marker.at - clipStartSec,
    }))
    .filter((marker) => marker.at >= 0 && (clipEndSec == null || marker.at <= clipEndSec - clipStartSec))

  return { segments, clickMarkers }
}

function getMediaDurationSeconds(filePath) {
  // Keep this helper local/sync: this script is short-lived and sequential.
  const output = execSync(
    `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${filePath}"`
  ).toString().trim()
  const duration = Number.parseFloat(output)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Konnte Dauer nicht auslesen: ${filePath}`)
  }
  return duration
}

// --- ffmpeg drawtext-Filter bauen ---
// This function builds one filter graph that performs all visual operations:
// - flatten overlapping step segments to a single active label per time slice
// - draw top-left step labels
// - overlay click markers in-place (no timeline extension)
// - concat all generated segments to one output stream [vout]
function buildVideoFilterComplex(segments, clickMarkers, videoDurationSec, options = {}) {
  const clickHoldDurationSec = Math.max(0, Number(options.clickHoldDurationSec) || 0)
  const clickFrameLeadSec = Math.max(0, Number(options.clickFrameLeadSec) || 0)
  const clickMarkerFadeSec = Math.max(0, Number(options.clickMarkerFadeSec) || 0)
  const clickMarkerImageInputLabel = typeof options.clickMarkerImageInputLabel === 'string'
    ? options.clickMarkerImageInputLabel
    : null
  const clickMarkerGlyph = String(options.clickMarkerGlyph || DEFAULT_CLICK_MARKER_GLYPH)
  const clickMarkerFont = String(options.clickMarkerFont || DEFAULT_CLICK_MARKER_FONT)
  const clickMarkerFontSize = Math.max(1, Number(options.clickMarkerFontSize) || DEFAULT_CLICK_MARKER_FONT_SIZE)
  const clickMarkerSizePx = Math.max(1, Number(options.clickMarkerSizePx) || DEFAULT_CLICK_MARKER_SIZE_PX)
  // Escape text for drawtext usage.
  const escape = (text) => text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')

  // Resolve overlapping segments: at any point in time only the deepest
  // (innermost/last-started) active step should be shown. We flatten the
  // segment list into non-overlapping intervals each showing exactly one label.
  const flatSegments = []
  if (segments.length > 0) {
    // Collect all unique timestamps as boundaries
    const times = new Set()
    for (const s of segments) {
      times.add(s.start)
      times.add(s.end)
    }
    const sorted = [...times].sort((a, b) => a - b)

    for (let i = 0; i + 1 < sorted.length; i++) {
      const t0 = sorted[i]
      const t1 = sorted[i + 1]
      const mid = (t0 + t1) / 2
      // Find all active segments at this interval; pick the deepest (last in array = most recently started)
      const active = segments.filter(s => s.start <= mid && s.end >= t1)
      if (active.length === 0) continue
      const deepest = active[active.length - 1]
      // Merge with previous flat segment if same label to avoid redundant filters
      if (flatSegments.length > 0 && flatSegments[flatSegments.length - 1].label === deepest.label) {
        flatSegments[flatSegments.length - 1].end = t1
      } else {
        flatSegments.push({ label: deepest.label, start: t0, end: t1 })
      }
    }
  }

  const textFilters = flatSegments.map(({ label, start, end }) => {
    // One drawtext node per non-overlapping interval
    const t = `gte(t,${start.toFixed(3)})*lt(t,${end.toFixed(3)})`
    return [
      `drawtext=text='${escape(label)}'`,
      `enable='${t}'`,
      `fontsize=22`,
      `fontcolor=white`,
      `box=1`,
      `boxcolor=black@0.6`,
      `boxborderw=6`,
      `x=16`,
      `y=16`,
      `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`,
    ].join(':')
  })

  const filterParts = []
  if (textFilters.length > 0) {
    filterParts.push(`[0:v]${textFilters.join(',')}[basev]`)
  } else {
    filterParts.push('[0:v]null[basev]')
  }

  const sortedClicks = [...clickMarkers].sort((left, right) => left.at - right.at)
  let previousSec = 0
  const operations = []

  // Convert each click into up to three operations:
  // - normal segment before marker window
  // - marker segment with overlay on original moving video
  // - normal segment after marker window
  for (const click of sortedClicks) {
    const clickAtSec = Math.min(videoDurationSec, Math.max(previousSec, click.at))
    const markerStartSec = Math.max(previousSec, clickAtSec - clickFrameLeadSec)
    const markerTailSec = Math.max(0, clickHoldDurationSec - clickFrameLeadSec)
    const markerEndSec = Math.min(videoDurationSec, clickAtSec + markerTailSec)

    if (markerStartSec > previousSec + 0.001) {
      operations.push({
        type: 'segment',
        start: previousSec,
        end: markerStartSec,
      })
    }

    if (markerEndSec > markerStartSec + 0.001) {
      operations.push({
        type: 'marker',
        start: markerStartSec,
        end: markerEndSec,
        x: click.x,
        y: click.y,
      })
      previousSec = markerEndSec
    } else {
      previousSec = markerStartSec
    }
  }

  if (videoDurationSec > previousSec + 0.001) {
    operations.push({
      type: 'segment',
      start: previousSec,
      end: videoDurationSec,
    })
  }

  if (operations.length === 0) {
    // No click marker overlays at all, just pass through base stream
    filterParts.push('[basev]null[vout]')
  } else {
    // Split base stream so each operation can trim its own time window
    const splitLabels = operations.map((_, index) => `[basesplit${index}]`)
    filterParts.push(`[basev]split=${operations.length}${splitLabels.join('')}`)

    const concatInputs = []
    const circleText = escape(clickMarkerGlyph)
    const markerOperationIndices = operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => operation.type === 'marker')
      .map(({ index }) => index)
    const clickImageLabelByOperationIndex = new Map()

    if (clickMarkerImageInputLabel && markerOperationIndices.length > 0) {
      const imageSplitLabels = markerOperationIndices.map((operationIndex) => `[clickimgsplit${operationIndex}]`)
      filterParts.push(
        `[${clickMarkerImageInputLabel}]format=rgba,split=${imageSplitLabels.length}${imageSplitLabels.join('')}`
      )
      for (const operationIndex of markerOperationIndices) {
        clickImageLabelByOperationIndex.set(operationIndex, `clickimgsplit${operationIndex}`)
      }
    }

    operations.forEach((operation, index) => {
      const sourceLabel = `basesplit${index}`
      if (operation.type === 'segment') {
        const segmentLabel = `vseg${index}`
        filterParts.push(
          `[${sourceLabel}]trim=start=${operation.start.toFixed(3)}:end=${operation.end.toFixed(3)},setpts=PTS-STARTPTS[${segmentLabel}]`
        )
        concatInputs.push(`[${segmentLabel}]`)
        return
      }

      const markerBaseLabel = `vmarkbase${index}`
      const markerLabel = `vmark${index}`
      const markerDurationSec = Math.max(0, operation.end - operation.start)
      filterParts.push(
        `[${sourceLabel}]trim=start=${operation.start.toFixed(3)}:end=${operation.end.toFixed(3)},setpts=PTS-STARTPTS[${markerBaseLabel}]`
      )

      if (clickMarkerImageInputLabel) {
        const imageSplitLabel = clickImageLabelByOperationIndex.get(index)
        const imageScaledLabel = `clickimgscaled${index}`
        const fadeInSec = Math.min(clickMarkerFadeSec, markerDurationSec / 2)
        const fadeOutSec = Math.min(clickMarkerFadeSec, Math.max(0, markerDurationSec - fadeInSec))
        const fadeOutStartSec = Math.max(0, markerDurationSec - fadeOutSec)

        if (fadeInSec > 0 || fadeOutSec > 0) {
          filterParts.push(
            `[${imageSplitLabel}]trim=start=0:end=${markerDurationSec.toFixed(3)},setpts=PTS-STARTPTS,format=rgba`
            + `,scale=w=${clickMarkerSizePx}:h=${clickMarkerSizePx}:force_original_aspect_ratio=decrease`
            + `${fadeInSec > 0 ? `,fade=t=in:st=0:d=${fadeInSec.toFixed(3)}:alpha=1` : ''}`
            + `${fadeOutSec > 0 ? `,fade=t=out:st=${fadeOutStartSec.toFixed(3)}:d=${fadeOutSec.toFixed(3)}:alpha=1` : ''}`
            + `[${imageScaledLabel}]`
          )
        } else {
          filterParts.push(
            `[${imageSplitLabel}]trim=start=0:end=${markerDurationSec.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,scale=w=${clickMarkerSizePx}:h=${clickMarkerSizePx}:force_original_aspect_ratio=decrease[${imageScaledLabel}]`
          )
        }

        filterParts.push(
          `[${markerBaseLabel}][${imageScaledLabel}]overlay=x=${operation.x}-overlay_w/2:y=${operation.y}-overlay_h/2:eof_action=pass[${markerLabel}]`
        )
      } else {
        filterParts.push(
          `[${markerBaseLabel}]drawtext=text='${circleText}':fontfile=${clickMarkerFont}:fontsize=${clickMarkerFontSize}:fontcolor=yellow:borderw=3:bordercolor=black:x=${operation.x}-text_w/2:y=${operation.y}-text_h/2[${markerLabel}]`
        )
      }
      concatInputs.push(`[${markerLabel}]`)
    })

    // Stitch all generated segments/holds into the final stream.
    if (concatInputs.length === 1) {
      filterParts.push(`${concatInputs[0]}null[vout]`)
    } else {
      filterParts.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[vout]`)
    }
  }

  return filterParts.join(';')
}

// --- Main ---
async function main() {
  console.log(`Lese Trace: ${traceZip}`)
  const traceEvents = await extractTraceEvents(traceZip)

  const { steps, clicks } = extractStepsAndClicks(traceEvents)
  if (steps.length === 0) {
    console.warn('Keine test.step-Einträge im Trace gefunden. Prüfe das Trace-Format.')
    process.exit(1)
  }

  console.log(`${steps.length} Schritte gefunden:`)
  const { segments, clickMarkers } = toVideoSeconds(steps, clicks, { clipStartMs, clipEndMs })
  const effectiveClickMarkers = clickEnabled && clickHoldDurationSec > 0 ? clickMarkers : []
  segments.forEach(({ label, start, end }) => {
    console.log(`  [${start.toFixed(1)}s – ${end.toFixed(1)}s] ${label}`)
  })
  if (effectiveClickMarkers.length > 0) {
    console.log(`${effectiveClickMarkers.length} Klick-Markierungen erkannt.`)
  }

  const videoDurationSec = clipEndMs !== null
    ? (clipEndMs - clipStartMs) / 1000
    : getMediaDurationSeconds(inputVideo) - (clipStartMs / 1000)
  const filter = buildVideoFilterComplex(segments, effectiveClickMarkers, videoDurationSec, {
    clickHoldDurationSec,
    clickFrameLeadSec,
    clickMarkerFadeSec: clickFadeSec,
    clickMarkerImageInputLabel: clickImagePath ? '1:v' : null,
    clickMarkerGlyph: DEFAULT_CLICK_MARKER_GLYPH,
    clickMarkerFont: DEFAULT_CLICK_MARKER_FONT,
    clickMarkerFontSize: DEFAULT_CLICK_MARKER_FONT_SIZE,
  })

  // Clip options are applied at input level, so filter timeline starts at 0.
  const clipArgs = []
  if (clipStartMs > 0) {
    clipArgs.push('-ss', (clipStartMs / 1000).toFixed(3))
  }
  if (clipEndMs !== null) {
    clipArgs.push('-to', (clipEndMs / 1000).toFixed(3))
  }

  const ffmpegArgs = [
    ...clipArgs,
    '-i', inputVideo,
    ...(clickImagePath ? ['-loop', '1', '-i', clickImagePath] : []),
    '-filter_complex', filter,
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'fast',
    outputVideo,
    '-y',
  ]

  console.log('\nFühre ffmpeg aus...')
  console.log(`ffmpeg ${ffmpegArgs.map((arg) => JSON.stringify(arg)).join(' ')}`)
  const ffmpegResult = spawnSync('ffmpeg', ffmpegArgs, {
    stdio: 'inherit',
  })
  if (ffmpegResult.error) {
    throw ffmpegResult.error
  }
  if ((ffmpegResult.status ?? 1) !== 0) {
    throw new Error(`ffmpeg fehlgeschlagen mit Exit-Code ${ffmpegResult.status ?? 1}`)
  }

  // No click holds are persisted because click markers are overlay-only and do
  // not extend timeline duration.
  const annotateMeta = {
    generatedAt: new Date().toISOString(),
    clickHoldDurationMs: 0,
    clickHolds: [],
  }
  await writeFile(
    getAnnotateMetaPath(outputVideo),
    JSON.stringify(annotateMeta, null, 2),
    'utf8'
  )

  console.log(`\nAnnotiertes Video gespeichert: ${outputVideo}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
