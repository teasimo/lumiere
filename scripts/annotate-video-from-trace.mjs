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

// Click marker behavior:
// - For each detected click, we insert a short freeze-frame hold in the video
// - During that hold we render a visible marker (circle) at click coordinates
// - These constants define hold duration and frame sampling around the click
const CLICK_HOLD_DURATION_SEC = 0.5
const CLICK_FRAME_SLICE_SEC = 0.04
const CLICK_FRAME_LEAD_SEC = 0.08
const CLICK_MARKER_GLYPH = '○'
const CLICK_MARKER_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const CLICK_MARKER_FONT_SIZE = 72

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
// - insert click hold segments with marker overlay
// - concat all generated segments to one output stream [vout]
function buildVideoFilterComplex(segments, clickMarkers, videoDurationSec) {
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

  // Convert each click into two output operations:
  // - normal segment up to click time
  // - fixed-length hold segment around click time with marker
  for (const click of sortedClicks) {
    const clickAtSec = Math.min(videoDurationSec, Math.max(previousSec, click.at))
    if (clickAtSec > previousSec + 0.001) {
      operations.push({
        type: 'segment',
        start: previousSec,
        end: clickAtSec,
      })
    }

    // Extract a tiny source slice near click time and extend with tpad(clone)
    // to create a hold frame of deterministic duration.
    let frameStart = Math.max(0, Math.min(videoDurationSec - CLICK_FRAME_SLICE_SEC, clickAtSec - CLICK_FRAME_LEAD_SEC))
    if (!Number.isFinite(frameStart)) frameStart = 0
    let frameEnd = Math.min(videoDurationSec, frameStart + CLICK_FRAME_SLICE_SEC)
    if (!(frameEnd > frameStart + 0.001)) {
      frameStart = Math.max(0, videoDurationSec - CLICK_FRAME_SLICE_SEC)
      frameEnd = Math.max(frameStart + CLICK_FRAME_SLICE_SEC, videoDurationSec)
    }

    operations.push({
      type: 'hold',
      frameStart,
      frameEnd,
      x: click.x,
      y: click.y,
    })

    previousSec = clickAtSec
  }

  if (videoDurationSec > previousSec + 0.001) {
    operations.push({
      type: 'segment',
      start: previousSec,
      end: videoDurationSec,
    })
  }

  if (operations.length === 0) {
    // No click holds at all, just pass through base stream
    filterParts.push('[basev]null[vout]')
  } else {
    // Split base stream so each operation can trim its own time window
    const splitLabels = operations.map((_, index) => `[basesplit${index}]`)
    filterParts.push(`[basev]split=${operations.length}${splitLabels.join('')}`)

    const concatInputs = []
    const circleText = escape(CLICK_MARKER_GLYPH)
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

      const holdBaseLabel = `vholdbase${index}`
      const holdLabel = `vhold${index}`
      // Build hold base, then draw click marker on top.
      filterParts.push(
        `[${sourceLabel}]trim=start=${operation.frameStart.toFixed(3)}:end=${operation.frameEnd.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${CLICK_HOLD_DURATION_SEC.toFixed(3)}[${holdBaseLabel}]`
      )
      filterParts.push(
        `[${holdBaseLabel}]drawtext=text='${circleText}':fontfile=${CLICK_MARKER_FONT}:fontsize=${CLICK_MARKER_FONT_SIZE}:fontcolor=yellow:borderw=3:bordercolor=black:x=${operation.x}-text_w/2:y=${operation.y}-text_h/2[${holdLabel}]`
      )
      concatInputs.push(`[${holdLabel}]`)
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
  segments.forEach(({ label, start, end }) => {
    console.log(`  [${start.toFixed(1)}s – ${end.toFixed(1)}s] ${label}`)
  })
  if (clickMarkers.length > 0) {
    console.log(`${clickMarkers.length} Klick-Markierungen erkannt.`)
  }

  const videoDurationSec = clipEndMs !== null
    ? (clipEndMs - clipStartMs) / 1000
    : getMediaDurationSeconds(inputVideo) - (clipStartMs / 1000)
  const filter = buildVideoFilterComplex(segments, clickMarkers, videoDurationSec)

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

  // Persist click-hold metadata for downstream timing reconciliation (e.g. TTS muxing).
  const annotateMeta = {
    generatedAt: new Date().toISOString(),
    clickHoldDurationMs: Math.round(CLICK_HOLD_DURATION_SEC * 1000),
    clickHolds: clickMarkers.map((marker) => ({
      atMs: Math.round(marker.at * 1000),
      durationMs: Math.round(CLICK_HOLD_DURATION_SEC * 1000),
      x: marker.x,
      y: marker.y,
    })),
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
