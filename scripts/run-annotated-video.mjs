#!/usr/bin/env node

import { existsSync } from 'fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { parse as parseYaml } from 'yaml'
import { loadCentralConfig } from './shared/central-config.mjs'

const OUTPUT_ROOT = resolve('output')
const OUTPUT_MANUAL_RUNS_ROOT = join(OUTPUT_ROOT, '_manual-runs')
const DEMO_LOGO_PATH = resolve('demo', 'img', 'lunettes.png')
const DEMO_LOGO_INTRO_DURATION_SEC = 2
const DEMO_TITLE_INTRO_DURATION_SEC = 2
const DEMO_TITLE_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const DEMO_INTRO_FADE_DURATION_SEC = 0.4
const DEMO_STEP_TITLE_DURATION_MS = 2000
const DEMO_TTS_CACHE_DIR = join(OUTPUT_ROOT, '_tts-cache')
const DEMO_TTS_INDEX_PATH = join(DEMO_TTS_CACHE_DIR, 'index.json')
const VIDEO_HOLD_FRAME_SLICE_SEC = 0.04
const VIDEO_HOLD_FRAME_LEAD_SEC = 0.08
const DEFAULT_SLOWMO_MS = 1000

let googleTtsModulePromise

function printUsage() {
  console.log(`Verwendung:
  node scripts/run-annotated-video.mjs --scenario-tts <scenario.yaml> --profile=<profil> [output.mp4] [--tts-voice=<name>]
  node scripts/run-annotated-video.mjs <testfile> [output.mp4] [--slowmo=<ms>] [--tts] [--tts-voice=<name>] [weitere Playwright-Argumente]
  node scripts/run-annotated-video.mjs --rerender <testfile> [output.mp4] [--tts] [--tts-voice=<name>]
  node scripts/run-annotated-video.mjs --annotate-only <trace.zip> <video.webm> <demoDir> [output.mp4] [--tts] [--tts-voice=<name>]
  node scripts/run-annotated-video.mjs --tts-only <annotated.mp4> <demoDir> [output-tts.mp4] [--tts-voice=<name>]

Beispiele:
  node scripts/run-annotated-video.mjs --scenario-tts lunettes/tests/login.yaml --profile=training-basic
  node scripts/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js
  node scripts/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js --slowmo=1000
  node scripts/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js annotated.mp4 --project=chromium
  node scripts/run-annotated-video.mjs --rerender tests/e2e/idee-flow.spec.js --tts
  node scripts/run-annotated-video.mjs --annotate-only ../output/my-scenario_1_0/artifacts/trace.zip ../output/my-scenario_1_0/artifacts/video.webm ../output/my-scenario_1_0/artifacts/demo annotated.mp4 --tts
  node scripts/run-annotated-video.mjs tests/e2e/idee-flow.spec.js --project=chromium --tts
  node scripts/run-annotated-video.mjs --tts-only output/_manual-runs/idee-flow-spec/20260425191328/final/idee-flow-spec-annotated-20260425191328.mp4 output/_manual-runs/idee-flow-spec/20260425191328/artifacts/demo --tts-voice=de-DE-Neural2-B
  npm run test:e2e:annotated-video -- tests/e2e/idee-planungsanker-plaintext-flow.spec.js --project=chromium
`)
}

function toRunId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function parseArgs(argv) {
  const args = [...argv]
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    return { help: true }
  }

  const scenarioTtsIndex = args.indexOf('--scenario-tts')
  if (scenarioTtsIndex >= 0) {
    args.splice(scenarioTtsIndex, 1)

    let profile = null
    let ttsVoice = null
    const positionalArgs = []
    const unsupportedArgs = []
    for (const arg of args) {
      if (arg.startsWith('--profile=')) {
        profile = arg.slice('--profile='.length).trim()
        continue
      }
      if (arg.startsWith('--tts-voice=')) {
        ttsVoice = arg.slice('--tts-voice='.length)
        continue
      }
      if (!arg.startsWith('-')) {
        positionalArgs.push(arg)
        continue
      }
      unsupportedArgs.push(arg)
    }

    const scenarioPath = positionalArgs[0]
    if (!scenarioPath) {
      throw new Error('Im Modus --scenario-tts wird eine Szenario-YAML als Positionsargument erwartet.')
    }

    let outputVideo = null
    if (positionalArgs[1]) {
      if (!/\.(mp4|webm|mov)$/i.test(positionalArgs[1])) {
        throw new Error(`Ungueltiges Ausgabeformat fuer --scenario-tts: ${positionalArgs[1]}`)
      }
      outputVideo = positionalArgs[1]
    }

    if (positionalArgs.length > 2) {
      unsupportedArgs.push(...positionalArgs.slice(2))
    }

    if (!profile) {
      throw new Error('Im Modus --scenario-tts ist --profile=<profil> erforderlich.')
    }

    if (unsupportedArgs.length > 0) {
      throw new Error(`Unbekannte Argumente fuer --scenario-tts: ${unsupportedArgs.join(', ')}`)
    }

    return {
      help: false,
      scenarioTts: true,
      scenarioPath,
      profile,
      outputVideo,
      ttsVoice,
    }
  }

  const rerenderIndex = args.indexOf('--rerender')
  if (rerenderIndex >= 0) {
    args.splice(rerenderIndex, 1)

    const testFile = args.shift()
    if (!testFile || testFile.startsWith('-')) {
      throw new Error('Im Modus --rerender wird als erstes Argument ein Playwright-Testfile erwartet.')
    }

    let outputVideo = null
    if (args[0] && !args[0].startsWith('-') && /\.(mp4|webm|mov)$/i.test(args[0])) {
      outputVideo = args.shift()
    }

    let tts = false
    let ttsVoice = null
    const unsupportedArgs = []
    for (const arg of args) {
      if (arg === '--tts') {
        tts = true
        continue
      }
      if (arg.startsWith('--tts-voice=')) {
        ttsVoice = arg.slice('--tts-voice='.length)
        continue
      }
      unsupportedArgs.push(arg)
    }

    if (unsupportedArgs.length > 0) {
      throw new Error(`Unbekannte Argumente fuer --rerender: ${unsupportedArgs.join(', ')}`)
    }

    return {
      help: false,
      rerender: true,
      testFile,
      outputVideo,
      tts,
      ttsVoice,
    }
  }

  const annotateOnlyIndex = args.indexOf('--annotate-only')
  if (annotateOnlyIndex >= 0) {
    args.splice(annotateOnlyIndex, 1)

    const tracePath = args.shift()
    const inputVideo = args.shift()
    const demoDir = args.shift()
    if (!tracePath || tracePath.startsWith('-')) {
      throw new Error('Im Modus --annotate-only wird als erstes Argument eine trace.zip erwartet.')
    }
    if (!inputVideo || inputVideo.startsWith('-')) {
      throw new Error('Im Modus --annotate-only wird als zweites Argument ein video.webm erwartet.')
    }
    if (!demoDir || demoDir.startsWith('-')) {
      throw new Error('Im Modus --annotate-only wird als drittes Argument das demo-Verzeichnis erwartet.')
    }

    let outputVideo = null
    if (args[0] && !args[0].startsWith('-') && /\.(mp4|webm|mov)$/i.test(args[0])) {
      outputVideo = args.shift()
    }

    let tts = false
    let ttsVoice = null
    const unsupportedArgs = []
    for (const arg of args) {
      if (arg === '--tts') {
        tts = true
        continue
      }
      if (arg.startsWith('--tts-voice=')) {
        ttsVoice = arg.slice('--tts-voice='.length)
        continue
      }
      unsupportedArgs.push(arg)
    }

    if (unsupportedArgs.length > 0) {
      throw new Error(`Unbekannte Argumente fuer --annotate-only: ${unsupportedArgs.join(', ')}`)
    }

    return {
      help: false,
      annotateOnly: true,
      tracePath,
      inputVideo,
      demoDir,
      outputVideo,
      tts,
      ttsVoice,
    }
  }

  const ttsOnlyIndex = args.indexOf('--tts-only')
  if (ttsOnlyIndex >= 0) {
    args.splice(ttsOnlyIndex, 1)

    const inputVideo = args.shift()
    const demoDir = args.shift()
    if (!inputVideo || inputVideo.startsWith('-')) {
      throw new Error('Im Modus --tts-only wird als erstes Argument ein vorhandenes annotiertes Video erwartet.')
    }
    if (!demoDir || demoDir.startsWith('-')) {
      throw new Error('Im Modus --tts-only wird als zweites Argument das demo-Verzeichnis erwartet.')
    }

    let outputVideo = null
    if (args[0] && !args[0].startsWith('-') && /\.(mp4|webm|mov)$/i.test(args[0])) {
      outputVideo = args.shift()
    }

    let ttsVoice = null
    const unsupportedArgs = []
    for (const arg of args) {
      if (arg.startsWith('--tts-voice=')) {
        ttsVoice = arg.slice('--tts-voice='.length)
        continue
      }
      unsupportedArgs.push(arg)
    }

    if (unsupportedArgs.length > 0) {
      throw new Error(`Unbekannte Argumente fuer --tts-only: ${unsupportedArgs.join(', ')}`)
    }

    return {
      help: false,
      ttsOnly: true,
      inputVideo,
      demoDir,
      outputVideo,
      ttsVoice,
    }
  }

  const testFile = args.shift()
  if (!testFile || testFile.startsWith('-')) {
    throw new Error('Als erstes Argument wird ein Playwright-Testfile erwartet.')
  }

  let outputVideo = null
  if (args[0] && !args[0].startsWith('-') && /\.(mp4|webm|mov)$/i.test(args[0])) {
    outputVideo = args.shift()
  }

  let slowMo = DEFAULT_SLOWMO_MS
  let tts = false
  let ttsVoice = null
  const filteredArgs = []
  for (const arg of args) {
    if (arg.startsWith('--slowmo=')) {
      slowMo = Number.parseInt(arg.slice('--slowmo='.length), 10)
      continue
    }
    if (arg === '--tts') {
      tts = true
      continue
    }
    if (arg.startsWith('--tts-voice=')) {
      ttsVoice = arg.slice('--tts-voice='.length)
      continue
    }
    filteredArgs.push(arg)
  }

  if (!Number.isFinite(slowMo) || slowMo < 0) {
    throw new Error('`--slowmo` muss eine Zahl >= 0 sein.')
  }

  return {
    help: false,
    ttsOnly: false,
    testFile,
    outputVideo,
    slowMo,
    tts,
    ttsVoice,
    playwrightArgs: filteredArgs,
  }
}

function runCommandWithOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  })

  if (result.error) {
    throw result.error
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = String(result.stderr || '').trim()
    const stdout = String(result.stdout || '').trim()
    throw new Error(stderr || stdout || `Kommando fehlgeschlagen: ${command} ${args.join(' ')}`)
  }

  return String(result.stdout || '')
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

function getAnnotateMetaPath(filePath) {
  return `${filePath}.annotate-meta.json`
}

async function readAnnotateMetaIfExists(filePath) {
  const meta = await readJsonIfExists(getAnnotateMetaPath(filePath))
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { clickHolds: [] }
  }
  const clickHolds = Array.isArray(meta.clickHolds) ? meta.clickHolds : []
  return { clickHolds }
}

function normalizeWorkspaceRelativePath(pathValue) {
  return String(pathValue || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
}

const SCENARIO_INTERACTION_SHORTHAND_KEYS = new Set([
  'open',
  'click',
  'fill',
  'append',
  'select',
  'wait',
  'assert',
  'scroll',
  'search-and-select',
  'extract-pdf-code',
  'set-runtime-variable',
])

function isChapterOnlyMarkerStep(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const chapterText = typeof value?.chapter?.text === 'string'
    ? value.chapter.text.trim()
    : ''
  if (!chapterText) {
    return false
  }

  const hasExecutionContent = Boolean(
    value.include
    || value.interaction
    || (Array.isArray(value.flow) && value.flow.length > 0)
    || Object.keys(value).some((key) => SCENARIO_INTERACTION_SHORTHAND_KEYS.has(key)),
  )

  return !hasExecutionContent
}

function stripPresentationDeep(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripPresentationDeep(entry))
      .filter((entry) => entry !== null)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  if (isChapterOnlyMarkerStep(value)) {
    // Chapter-only markers do not affect raw test interaction execution and
    // therefore must not invalidate reuse of an existing raw video/timeline.
    return null
  }

  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'presentation' || key === 'didactics' || key === 'didactic' || key === 'chapter') {
      continue
    }
    result[key] = stripPresentationDeep(entry)
  }

  return result
}

function toCanonicalComparable(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => toCanonicalComparable(entry))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const ordered = {}
  for (const key of Object.keys(value).sort()) {
    ordered[key] = toCanonicalComparable(value[key])
  }

  return ordered
}

function buildScenarioComparablePayload(parsedScenario) {
  const root = parsedScenario?.interaction || parsedScenario || {}
  return toCanonicalComparable(stripPresentationDeep(root))
}

async function assertScenarioMatchesRawVideoIgnoringPresentation({
  scenarioAbsolutePath,
  scenarioPathRelative,
  artifactsDir,
}) {
  const scenarioOutputRoot = dirname(artifactsDir)
  const runMetaPath = join(scenarioOutputRoot, 'run-meta.json')
  const runMeta = await readJsonIfExists(runMetaPath)

  const sourcePathFromMeta = normalizeWorkspaceRelativePath(runMeta?.scenario?.sourcePathRelative || scenarioPathRelative)
  const snapshotScenarioPath = join(scenarioOutputRoot, basename(sourcePathFromMeta))

  if (!existsSync(snapshotScenarioPath)) {
    throw new Error([
      'Kompatibilitaetspruefung fehlgeschlagen: Kein YAML-Snapshot zum Rohvideo gefunden.',
      `Erwartet: ${snapshotScenarioPath}`,
      'Bitte Rohvideo neu erzeugen.',
    ].join(' '))
  }

  const [currentRaw, snapshotRaw] = await Promise.all([
    readFile(scenarioAbsolutePath, 'utf8'),
    readFile(snapshotScenarioPath, 'utf8'),
  ])

  const currentParsed = parseYaml(currentRaw) || {}
  const snapshotParsed = parseYaml(snapshotRaw) || {}

  const currentComparable = buildScenarioComparablePayload(currentParsed)
  const snapshotComparable = buildScenarioComparablePayload(snapshotParsed)

  const currentJson = JSON.stringify(currentComparable)
  const snapshotJson = JSON.stringify(snapshotComparable)

  if (currentJson !== snapshotJson) {
    throw new Error([
      'Das aktuelle YAML passt nicht mehr zum vorhandenen Rohvideo (Vergleich ignoriert presentation).',
      'Bitte zuerst das Rohvideo neu generieren:',
      `npm run generate:video:force -- ${scenarioPathRelative}`,
    ].join(' '))
  }
}

function resolveScenarioTtsProfile(centralConfig, profileName) {
  const profiles = Array.isArray(centralConfig?.tts) ? centralConfig.tts : []
  const normalizedProfileName = String(profileName || '').trim()
  const found = profiles.find((entry) => String(entry?.profile || '').trim() === normalizedProfileName)

  if (!found) {
    const available = profiles
      .map((entry) => String(entry?.profile || '').trim())
      .filter(Boolean)
      .join(', ')
    throw new Error(`TTS-Profil nicht gefunden: ${normalizedProfileName}${available ? ` (verfuegbar: ${available})` : ''}`)
  }

  return found
}

function resolveScenarioClickIndicatorConfig(scenarioRoot) {
  const clickConfig = scenarioRoot?.presentation?.indicators?.click
  if (!clickConfig || typeof clickConfig !== 'object') {
    return null
  }

  const enabled = clickConfig.enabled !== false
  const beforeMs = Math.max(0, Number(clickConfig.before_ms) || 0)
  const afterMs = Math.max(0, Number(clickConfig.after_ms) || 0)
  const fadeMs = Math.max(0, Number(clickConfig.fade_ms) || 0)

  return {
    enabled,
    beforeMs,
    afterMs,
    fadeMs,
  }
}

function buildAnnotateClickIndicatorArgs(clickIndicatorConfig) {
  if (!clickIndicatorConfig || clickIndicatorConfig.enabled !== true) {
    return ['--click-enabled=false']
  }

  const args = ['--click-enabled=true']
  args.push(`--click-before-ms=${Math.max(0, Math.floor(clickIndicatorConfig.beforeMs || 0))}`)
  args.push(`--click-after-ms=${Math.max(0, Math.floor(clickIndicatorConfig.afterMs || 0))}`)
  args.push(`--click-fade-ms=${Math.max(0, Math.floor(clickIndicatorConfig.fadeMs || 0))}`)
  return args
}

function resolveDidacticText(stepEntry, channelName) {
  const didactics =
    stepEntry?.presentation?.didactics
    || stepEntry?.didactics
    || stepEntry?.didactic
  if (!didactics || typeof didactics !== 'object') return null
  const candidate = didactics[channelName]
  if (!candidate || typeof candidate !== 'object') return null
  const text = typeof candidate.text === 'string'
    ? candidate.text.trim()
    : (typeof candidate.explanation === 'string' ? candidate.explanation.trim() : '')
  return text || null
}

function flattenFlowSteps(flowEntries, out = [], idPrefix = '') {
  for (const step of flowEntries || []) {
    if (!step || typeof step !== 'object') {
      continue
    }

    const stepId = String(step.id || '').trim()
    if (!stepId) {
      continue
    }

    const fullId = idPrefix ? `${idPrefix}-${stepId}` : stepId
    out.push({
      id: fullId,
      step,
      isIncludeContainer: Boolean(step.include),
    })

    if (Array.isArray(step.flow) && step.flow.length > 0) {
      flattenFlowSteps(step.flow, out, fullId)
    }
  }

  return out
}

function resolveScenarioStepMatchForTimelineStep(timelineStepId, flattenedFlowStepEntries) {
  const normalizedTimelineStepId = String(timelineStepId || '').trim()
  if (!normalizedTimelineStepId) {
    return null
  }

  let bestMatch = null
  let bestLength = -1

  for (const entry of flattenedFlowStepEntries || []) {
    const flowStepId = String(entry?.id || '').trim()
    if (!flowStepId) {
      continue
    }

    const isExact = normalizedTimelineStepId === flowStepId
    const isPrefix = Boolean(entry?.isIncludeContainer) && normalizedTimelineStepId.startsWith(`${flowStepId}-`)
    const isMatch = isExact || isPrefix
    if (!isMatch) {
      continue
    }

    if (flowStepId.length > bestLength) {
      bestLength = flowStepId.length
      bestMatch = {
        id: flowStepId,
        step: entry?.step || null,
        matchKind: isExact ? 'exact' : 'prefix',
      }
    }
  }

  return bestMatch
}

function timelineStepMatchesScenarioStepId(timelineStepId, scenarioStepId) {
  const normalizedTimelineStepId = String(timelineStepId || '').trim()
  const normalizedScenarioStepId = String(scenarioStepId || '').trim()
  if (!normalizedTimelineStepId || !normalizedScenarioStepId) {
    return false
  }
  return (
    normalizedTimelineStepId === normalizedScenarioStepId
    || normalizedTimelineStepId.startsWith(`${normalizedScenarioStepId}-`)
  )
}

function collectPresentationVideoDirectivesFromFlow(flowEntries, out = []) {
  for (const step of flowEntries || []) {
    if (!step || typeof step !== 'object') {
      continue
    }

    const presentationVideo = step?.presentation?.video
    if (presentationVideo && typeof presentationVideo === 'object') {
      const start = presentationVideo.start != null ? String(presentationVideo.start).trim().toLowerCase() : null
      const stop = presentationVideo.stop != null ? String(presentationVideo.stop).trim().toLowerCase() : null
      if (start || stop) {
        out.push({
          stepId: String(step.id || '').trim(),
          start,
          stop,
        })
      }
    }

    if (Array.isArray(step.flow) && step.flow.length > 0) {
      collectPresentationVideoDirectivesFromFlow(step.flow, out)
    }
  }

  return out
}

function resolvePresentationStepWindowMs(stepId, timelineSteps) {
  const normalizedStepId = String(stepId || '').trim()
  if (!normalizedStepId) {
    return null
  }

  const exactMatches = timelineSteps.filter((entry) => String(entry?.stepId || '').trim() === normalizedStepId)
  const prefixMatches = timelineSteps.filter((entry) => String(entry?.stepId || '').trim().startsWith(`${normalizedStepId}-`))
  const matches = exactMatches.length > 0 ? exactMatches : prefixMatches
  if (matches.length === 0) {
    return null
  }

  let minStartedAt = Number.POSITIVE_INFINITY
  let maxEndedAt = Number.NEGATIVE_INFINITY
  for (const match of matches) {
    const startedAtMs = Number(match?.startedAtMs)
    const endedAtMs = Number(match?.endedAtMs)
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
      continue
    }
    minStartedAt = Math.min(minStartedAt, startedAtMs)
    maxEndedAt = Math.max(maxEndedAt, endedAtMs)
  }

  if (!Number.isFinite(minStartedAt) || !Number.isFinite(maxEndedAt)) {
    return null
  }

  return {
    startedAtMs: minStartedAt,
    endedAtMs: maxEndedAt,
  }
}

function resolveScenarioPresentationVideoRangeFromTimeline({ scenarioRoot, timelineReport }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const timelineSteps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  if (!flow.length || !timelineSteps.length) {
    return null
  }

  const directives = collectPresentationVideoDirectivesFromFlow(flow)
  if (!directives.length) {
    return null
  }

  const sortedTimelineSteps = [...timelineSteps].sort((left, right) => Number(left.startedAtMs || 0) - Number(right.startedAtMs || 0))
  const originMs = Number(sortedTimelineSteps[0]?.startedAtMs || 0)
  if (!Number.isFinite(originMs)) {
    return null
  }

  let startAbsMs = null
  let endAbsMs = null
  let startDirectiveStepId = null

  for (const directive of directives) {
    const window = resolvePresentationStepWindowMs(directive.stepId, sortedTimelineSteps)
    if (!window) {
      console.warn(`[scenario-tts] presentation.video for step "${directive.stepId}" ignored: step not found in timeline.`)
      continue
    }

    if (directive.start === 'before') {
      startAbsMs = window.startedAtMs
      startDirectiveStepId = directive.stepId
    } else if (directive.start === 'after') {
      startAbsMs = window.endedAtMs
      startDirectiveStepId = directive.stepId
    }

    if (directive.stop === 'before') {
      endAbsMs = window.startedAtMs
    } else if (directive.stop === 'after') {
      endAbsMs = window.endedAtMs
    }
  }

  if (startAbsMs == null && endAbsMs == null) {
    return null
  }

  const startMs = startAbsMs == null ? 0 : Math.max(0, Math.floor(startAbsMs - originMs))
  const endMs = endAbsMs == null ? null : Math.max(0, Math.floor(endAbsMs - originMs))

  if (endMs != null && endMs <= startMs) {
    throw new Error(`presentation.video defines an invalid clip range: start=${startMs}ms, stop=${endMs}ms.`)
  }

  return {
    startMs,
    endMs,
    startDirectiveStepId,
    directives,
  }
}

function cutVideoToRange({ inputVideo, outputVideo, startMs = 0, endMs = null }) {
  const startSec = Math.max(0, Number(startMs) || 0) / 1000
  const args = ['-y', '-ss', startSec.toFixed(3), '-i', inputVideo]

  if (endMs != null) {
    const durationMs = Math.max(0, Number(endMs) - Number(startMs || 0))
    const durationSec = durationMs / 1000
    args.push('-t', durationSec.toFixed(3))
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-an',
    outputVideo,
  )

  runCommand('ffmpeg', args)
}

function buildNarrationsFromScenarioTimeline({ scenarioRoot, timelineReport, profile, voiceOverride = null }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const steps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  if (!steps.length) {
    throw new Error('Timeline enthaelt keine Schritte.')
  }

  const flattenedFlowStepEntries = flattenFlowSteps(flow)
  const channelsConfig = profile?.channels && typeof profile.channels === 'object' ? profile.channels : {}
  const timing = profile?.timing && typeof profile.timing === 'object' ? profile.timing : {}
  const beforeChannels = Array.isArray(timing.before_step) ? timing.before_step.map(String) : []
  const duringChannels = Array.isArray(timing.during_step) ? timing.during_step.map(String) : []
  const afterChannels = Array.isArray(timing.after_step) ? timing.after_step.map(String) : []
  const pauses = profile?.pauses && typeof profile.pauses === 'object' ? profile.pauses : {}
  const betweenChannelsMs = Math.max(0, Number(pauses.between_channels_ms) || 0)
  const beforeActionMs = Math.max(0, Number(pauses.before_action_ms) || 0)
  const afterActionMs = Math.max(0, Number(pauses.after_action_ms) || 0)
  const minWindowMs = Math.max(1, betweenChannelsMs || 1)
  const profileVoice = typeof profile?.voice === 'string' && profile.voice.trim() ? profile.voice.trim() : null

  const sortedSteps = [...steps].sort((left, right) => Number(left.startedAtMs || 0) - Number(right.startedAtMs || 0))
  const originMs = Number(sortedSteps[0]?.startedAtMs || 0)
  const narrations = []
  const consumedPrefixDidacticsStepIds = new Set()

  function appendSequence({ stepId, scenarioStepId, stepEntry, anchor, channelList, baseMs }) {
    let cursor = Math.max(0, Math.floor(baseMs))

    for (const channelNameRaw of channelList) {
      const channelName = String(channelNameRaw || '').trim()
      if (!channelName) continue

      const channelConfig = channelsConfig[channelName]
      if (!channelConfig || channelConfig.enabled !== true) {
        continue
      }

      const didacticText = resolveDidacticText(stepEntry, channelName)
      if (!didacticText) {
        continue
      }

      const prefix = typeof channelConfig.prefix === 'string' ? channelConfig.prefix.trim() : ''
      const spokenText = prefix ? `${prefix} ${didacticText}` : didacticText

      const startMs = Math.max(0, Math.floor(cursor))
      const endMs = Math.max(startMs + 1, Math.floor(cursor + minWindowMs))
      narrations.push({
        id: `${stepId}-${anchor}-${channelName}`,
        startMs,
        endMs,
        text: spokenText,
        sourceTimelineStepId: stepId,
        sourceScenarioStepId: scenarioStepId,
        sourceAnchor: anchor,
        voice: voiceOverride || profileVoice || undefined,
      })

      cursor = endMs + betweenChannelsMs
    }
  }

  for (let index = 0; index < sortedSteps.length; index += 1) {
    const timelineStep = sortedSteps[index]
    const stepId = String(timelineStep?.stepId || '').trim()
    if (!stepId) continue

    const startedAtMs = Number(timelineStep.startedAtMs)
    const endedAtMs = Number(timelineStep.endedAtMs)
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
      continue
    }

    const stepMatch = resolveScenarioStepMatchForTimelineStep(stepId, flattenedFlowStepEntries)
    const matchedStepId = String(stepMatch?.id || '').trim()
    let stepEntry = stepMatch?.step || null

    if (matchedStepId && stepMatch?.matchKind === 'prefix') {
      if (consumedPrefixDidacticsStepIds.has(matchedStepId)) {
        stepEntry = null
      } else {
        consumedPrefixDidacticsStepIds.add(matchedStepId)
      }
    }

    let anchorStartAbsMs = startedAtMs
    let anchorEndAbsMs = endedAtMs
    let narrationStepId = stepId

    if (matchedStepId && stepMatch?.matchKind === 'prefix') {
      let firstPrefixStepId = stepId

      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const previousStepId = String(sortedSteps[previous]?.stepId || '').trim()
        if (!timelineStepMatchesScenarioStepId(previousStepId, matchedStepId)) {
          break
        }

        if (previousStepId) {
          firstPrefixStepId = previousStepId
        }

        const previousStartedAtMs = Number(sortedSteps[previous]?.startedAtMs)
        const previousEndedAtMs = Number(sortedSteps[previous]?.endedAtMs)
        if (Number.isFinite(previousStartedAtMs) && Number.isFinite(previousEndedAtMs) && previousEndedAtMs >= previousStartedAtMs) {
          anchorStartAbsMs = previousStartedAtMs
        }
      }

      for (let next = index + 1; next < sortedSteps.length; next += 1) {
        const nextStepId = String(sortedSteps[next]?.stepId || '').trim()
        if (!timelineStepMatchesScenarioStepId(nextStepId, matchedStepId)) {
          break
        }

        const nextStartedAtMs = Number(sortedSteps[next]?.startedAtMs)
        const nextEndedAtMs = Number(sortedSteps[next]?.endedAtMs)
        if (Number.isFinite(nextStartedAtMs) && Number.isFinite(nextEndedAtMs) && nextEndedAtMs >= nextStartedAtMs) {
          anchorEndAbsMs = nextEndedAtMs
        }
      }

      if (firstPrefixStepId) {
        narrationStepId = firstPrefixStepId
      }
    }

    const stepStartMs = Math.max(0, Math.floor(anchorStartAbsMs - originMs))
    const stepEndMs = Math.max(stepStartMs, Math.floor(anchorEndAbsMs - originMs))

    appendSequence({
      stepId: narrationStepId,
      scenarioStepId: matchedStepId || stepId,
      stepEntry,
      anchor: 'before',
      channelList: beforeChannels,
      baseMs: Math.max(0, stepStartMs - beforeActionMs),
    })

    appendSequence({
      stepId: narrationStepId,
      scenarioStepId: matchedStepId || stepId,
      stepEntry,
      anchor: 'during',
      channelList: duringChannels,
      baseMs: stepStartMs,
    })

    appendSequence({
      stepId: narrationStepId,
      scenarioStepId: matchedStepId || stepId,
      stepEntry,
      anchor: 'after',
      channelList: afterChannels,
      baseMs: stepEndMs + afterActionMs,
    })
  }

  narrations.sort((left, right) => left.startMs - right.startMs)
  return narrations
}

function resolveScenarioChapterCard(stepEntry) {
  const chapter = stepEntry?.chapter
  if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) {
    return null
  }

  const text = typeof chapter.text === 'string' ? chapter.text.trim() : ''
  if (!text) {
    return null
  }

  const rawDuration = Number(chapter.duration_ms ?? chapter.durationMs)
  const durationMs = Math.max(
    1000,
    Number.isFinite(rawDuration) ? Math.floor(rawDuration) : DEMO_STEP_TITLE_DURATION_MS,
  )

  return {
    text,
    durationMs,
  }
}

function buildScenarioChapterTitlesFromTimeline({ scenarioRoot, timelineReport, presentationRange = null }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const steps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  if (!flow.length || !steps.length) {
    return []
  }

  const flattenedFlowStepEntries = flattenFlowSteps(flow)
  const sortedSteps = [...steps].sort((left, right) => Number(left.startedAtMs || 0) - Number(right.startedAtMs || 0))
  const originMs = Number(sortedSteps[0]?.startedAtMs || 0)
  if (!Number.isFinite(originMs)) {
    return []
  }

  const clipStartMs = presentationRange ? Math.max(0, Number(presentationRange.startMs) || 0) : 0
  const clipEndMs = presentationRange?.endMs == null ? null : Math.max(0, Number(presentationRange.endMs) || 0)
  const chapterTitles = []

  for (let index = 0; index < flattenedFlowStepEntries.length; index += 1) {
    const flowEntry = flattenedFlowStepEntries[index]
    const stepEntry = flowEntry?.step || null
    const chapterCard = resolveScenarioChapterCard(stepEntry)
    if (!chapterCard) {
      continue
    }

    const chapterStepId = String(flowEntry?.id || '').trim()
    if (!chapterStepId) {
      continue
    }

    let window = resolvePresentationStepWindowMs(chapterStepId, sortedSteps)

    if (!window) {
      for (let nextIndex = index + 1; nextIndex < flattenedFlowStepEntries.length; nextIndex += 1) {
        const nextId = String(flattenedFlowStepEntries[nextIndex]?.id || '').trim()
        if (!nextId) {
          continue
        }
        window = resolvePresentationStepWindowMs(nextId, sortedSteps)
        if (window) {
          break
        }
      }
    }

    let anchorAbsMs = null
    if (window) {
      anchorAbsMs = Number(window.startedAtMs)
    } else {
      for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
        const previousId = String(flattenedFlowStepEntries[previousIndex]?.id || '').trim()
        if (!previousId) {
          continue
        }
        const previousWindow = resolvePresentationStepWindowMs(previousId, sortedSteps)
        if (previousWindow) {
          anchorAbsMs = Number(previousWindow.endedAtMs)
          break
        }
      }
    }

    if (!Number.isFinite(anchorAbsMs)) {
      continue
    }

    const absoluteAtMs = Math.max(0, Math.floor(anchorAbsMs - originMs))
    if (absoluteAtMs < clipStartMs) {
      chapterTitles.push({
        id: `${chapterStepId}-chapter`,
        title: chapterCard.text,
        atMs: 0,
        durationMs: chapterCard.durationMs,
        sourceTimelineStepId: chapterStepId,
        sourceScenarioStepId: chapterStepId,
      })
      continue
    }
    if (clipEndMs != null && absoluteAtMs >= clipEndMs) {
      continue
    }

    chapterTitles.push({
      id: `${chapterStepId}-chapter`,
      title: chapterCard.text,
      atMs: Math.max(0, absoluteAtMs - clipStartMs),
      durationMs: chapterCard.durationMs,
      sourceTimelineStepId: chapterStepId,
      sourceScenarioStepId: chapterStepId,
    })
  }

  chapterTitles.sort((left, right) => left.atMs - right.atMs)
  return chapterTitles
}

async function findLatestScenarioVideoTimelinePair({ outputDir, scenarioPathRelative }) {
  if (!existsSync(outputDir)) return null
  const normalizedScenarioPath = normalizeWorkspaceRelativePath(scenarioPathRelative)

  const dirs = [outputDir, ...await collectArtifactDirs(outputDir)]
  const candidates = []

  for (const dir of dirs) {
    const videoPath = join(dir, 'video.webm')
    const timelinePath = join(dir, 'yaml-step-timeline.json')
    if (!existsSync(videoPath) || !existsSync(timelinePath)) {
      continue
    }

    const timeline = await readJsonIfExists(timelinePath)
    const source = normalizeWorkspaceRelativePath(timeline?.scenarioSource)
    if (source !== normalizedScenarioPath) {
      continue
    }

    const timelineStat = await stat(timelinePath)
    candidates.push({
      dir,
      videoPath,
      timelinePath,
      timeline,
      mtimeMs: timelineStat.mtimeMs,
    })
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0] || null
}

async function ensureScenarioVideoTimelinePair({ scenarioPathRelative }) {
  const outputRoot = OUTPUT_ROOT
  const existing = await findLatestScenarioVideoTimelinePair({
    outputDir: outputRoot,
    scenarioPathRelative,
  })
  if (existing) {
    return existing
  }

  throw new Error([
    'Kein vorhandenes Rohvideo fuer das Szenario gefunden.',
    `Erwartet unter output/* mit scenarioSource=${scenarioPathRelative}.`,
    `Bitte zuerst ausfuehren: npm run generate:video:force -- ${scenarioPathRelative}`,
  ].join(' '))
}

function applyClickHoldShift(timeMs, clickHolds) {
  let shiftMs = 0
  for (const hold of clickHolds) {
    const atMs = Number(hold?.atMs)
    const durationMs = Number(hold?.durationMs)
    if (!Number.isFinite(atMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
      continue
    }
    if (timeMs >= atMs) {
      shiftMs += durationMs
    }
  }
  return timeMs + shiftMs
}

async function resolveVideoTitleFromDemoDir(demoDir) {
  const titleData = (await readJsonIfExists(join(demoDir, 'timeline.title.json'))) || {}
  const title = typeof titleData.title === 'string' ? titleData.title.trim() : ''
  return title || null
}

async function resolveVideoClipFromDemoDir(demoDir) {
  const events = (await readJsonIfExists(join(demoDir, 'timeline.events.json')))
    || (await readJsonIfExists(join(demoDir, 'timeline.clicks.json')))
    || []
  const videoRange = (await readJsonIfExists(join(demoDir, 'timeline.video.json'))) || {}
  const eventMap = new Map((Array.isArray(events) ? events : []).map((entry) => [String(entry.id), Number(entry.tMs || 0)]))

  let startMs = 0
  let endMs = null

  if (videoRange.startAfter) {
    if (!eventMap.has(String(videoRange.startAfter))) {
      throw new Error(`Video-Start-Event nicht gefunden (${videoRange.startAfter}).`)
    }
    startMs = Number(eventMap.get(String(videoRange.startAfter)))
  }

  if (videoRange.endBefore) {
    if (!eventMap.has(String(videoRange.endBefore))) {
      throw new Error(`Video-End-Event nicht gefunden (${videoRange.endBefore}).`)
    }
    endMs = Number(eventMap.get(String(videoRange.endBefore)))
  }

  if (!Number.isFinite(startMs) || startMs < 0) {
    throw new Error(`Ungueltiger Video-Start: ${startMs}`)
  }

  if (endMs !== null && (!Number.isFinite(endMs) || endMs <= startMs)) {
    throw new Error(`Ungueltiger Video-Bereich: ${startMs}..${endMs}`)
  }

  return {
    startMs,
    endMs,
  }
}

// Returns step titles with atMs in original clip-relative time (no click-hold shift applied).
// Click-hold shifting is done separately so that click holds and step title holds can be
// combined into a single ordered hold list for narration time resolution.
async function resolveStepTitlesFromDemoDir(demoDir) {
  const clip = await resolveVideoClipFromDemoDir(demoDir)
  const events = (await readJsonIfExists(join(demoDir, 'timeline.events.json')))
    || (await readJsonIfExists(join(demoDir, 'timeline.clicks.json')))
    || []
  const stepTitles = (await readJsonIfExists(join(demoDir, 'timeline.step-titles.json'))) || []
  const eventMap = new Map((Array.isArray(events) ? events : []).map((entry) => [String(entry.id), Number(entry.tMs || 0)]))

  const resolved = (Array.isArray(stepTitles) ? stepTitles : []).map((entry) => {
    const atId = String(entry.atEvent || '')
    if (!atId || !eventMap.has(atId)) {
      throw new Error(`Step-Title ${entry.id || 'unknown'}: atEvent nicht gefunden (${atId || 'leer'}).`)
    }
    const atMs = Number(eventMap.get(atId))
    const title = String(entry.title || '').trim()
    if (!title) {
      throw new Error(`Step-Title ${entry.id || 'unknown'}: title darf nicht leer sein.`)
    }
    const durationMs = Math.max(1000, Number(entry.durationMs) || DEMO_STEP_TITLE_DURATION_MS)
    const clipRelativeAtMs = atMs - clip.startMs
    if (clip.endMs !== null && atMs >= clip.endMs) return null
    return {
      id: String(entry.id),
      title,
      atMs: clipRelativeAtMs,
      durationMs,
    }
  }).filter(Boolean)

  resolved.sort((a, b) => a.atMs - b.atMs)
  return resolved
}

async function resolveNarrationsFromDemoDir(demoDir, options = {}) {
  const clip = await resolveVideoClipFromDemoDir(demoDir)
  const clickHolds = Array.isArray(options.clickHolds) ? [...options.clickHolds] : []
  clickHolds.sort((left, right) => Number(left?.atMs || 0) - Number(right?.atMs || 0))
  const events = (await readJsonIfExists(join(demoDir, 'timeline.events.json')))
    || (await readJsonIfExists(join(demoDir, 'timeline.clicks.json')))
    || []
  const narrations = (await readJsonIfExists(join(demoDir, 'timeline.narrations.json'))) || []
  const eventMap = new Map((Array.isArray(events) ? events : []).map((entry) => [String(entry.id), Number(entry.tMs || 0)]))

  const resolved = (Array.isArray(narrations) ? narrations : []).map((entry) => {
    const startId = String(entry.startAfterEvent || entry.startAfterClick || entry.after || '')
    const endId = String(entry.endBeforeEvent || entry.endBeforeClick || entry.before || '')
    const startMs = Number(eventMap.get(startId))
    const endMs = Number(eventMap.get(endId))
    if (!startId || !eventMap.has(startId)) {
      throw new Error(`Narration ${entry.id || 'unknown'}: start-Event nicht gefunden (${startId || 'leer'}).`)
    }
    if (!endId || !eventMap.has(endId)) {
      throw new Error(`Narration ${entry.id || 'unknown'}: end-Event nicht gefunden (${endId || 'leer'}).`)
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error(`Narration ${entry.id || 'unknown'}: ungueltiger Zeitbereich (${startMs}..${endMs}).`)
    }
    if ((!entry.text && !entry.ssml) || (entry.text && entry.ssml)) {
      throw new Error(`Narration ${entry.id || 'unknown'}: genau text oder ssml erforderlich.`)
    }

    const clippedStartMs = Math.max(startMs, clip.startMs)
    const clippedEndMs = clip.endMs === null ? endMs : Math.min(endMs, clip.endMs)
    if (clippedStartMs >= clippedEndMs) {
      return null
    }

    return {
      id: String(entry.id || `narration-${startMs}`),
      startMs: applyClickHoldShift(clippedStartMs - clip.startMs, clickHolds),
      endMs: applyClickHoldShift(clippedEndMs - clip.startMs, clickHolds),
      text: entry.text ? String(entry.text) : undefined,
      ssml: entry.ssml ? String(entry.ssml) : undefined,
      voice: entry.voice ? String(entry.voice) : undefined,
    }
  }).filter(Boolean)

  resolved.sort((left, right) => left.startMs - right.startMs)
  await writeFile(join(demoDir, 'timeline.resolved.json'), JSON.stringify(resolved, null, 2), 'utf8')
  return resolved
}

async function loadGoogleTtsModule() {
  if (googleTtsModulePromise === undefined) {
    googleTtsModulePromise = import('@google-cloud/text-to-speech')
      .then((module) => module.default)
      .catch(() => null)
  }
  return googleTtsModulePromise
}

async function resolveTtsEngineName() {
  const textToSpeech = await loadGoogleTtsModule()
  if (textToSpeech && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return 'google-cloud-text-to-speech'
  }
  return 'ffmpeg-flite'
}

function getEffectiveTtsVoice({ narration, voiceOverride, engine }) {
  if (engine === 'google-cloud-text-to-speech') {
    return voiceOverride || narration.voice || 'de-DE-Neural2-B'
  }
  return 'slt'
}

async function loadTtsCacheIndex() {
  await mkdir(DEMO_TTS_CACHE_DIR, { recursive: true })
  const rawIndex = await readJsonIfExists(DEMO_TTS_INDEX_PATH)
  if (!rawIndex || typeof rawIndex !== 'object' || Array.isArray(rawIndex)) {
    return { version: 1, entries: {} }
  }

  const entries = rawIndex.entries && typeof rawIndex.entries === 'object' && !Array.isArray(rawIndex.entries)
    ? rawIndex.entries
    : {}

  return {
    version: 1,
    entries,
  }
}

async function writeTtsCacheIndex(index) {
  await mkdir(DEMO_TTS_CACHE_DIR, { recursive: true })
  await writeFile(DEMO_TTS_INDEX_PATH, JSON.stringify(index, null, 2), 'utf8')
}

function buildTtsCacheRecord({ narration, engine, voice }) {
  return {
    engine,
    voice,
    text: narration.text || null,
    ssml: narration.ssml || null,
  }
}

function buildTtsCacheKey(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

async function synthesizeWithGoogleTts(narration, outPath, voiceOverride = null) {
  const textToSpeech = await loadGoogleTtsModule()
  if (!textToSpeech) {
    return false
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return false
  }

  const client = new textToSpeech.TextToSpeechClient()
  const [response] = await client.synthesizeSpeech({
    input: narration.ssml ? { ssml: narration.ssml } : { text: narration.text },
    voice: {
      languageCode: 'de-DE',
      name: voiceOverride || narration.voice || 'de-DE-Neural2-B',
    },
    audioConfig: {
      audioEncoding: 'MP3',
    },
  })
  await writeFile(outPath, response.audioContent)
  return true
}

async function synthesizeWithFfmpegFlite(narration, outPath, tempDir) {
  const textPath = join(tempDir, `${narration.id}.txt`)
  const plainText = narration.ssml
    ? narration.ssml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : narration.text
  await writeFile(textPath, plainText || narration.id, 'utf8')

  const fliteInput = `flite=textfile='${textPath.replace(/'/g, "'\\''")}':voice=slt`
  runCommand('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', fliteInput,
    '-ar', '24000',
    '-ac', '2',
    outPath,
  ])
}

async function synthesizeNarrations(demoDir, narrations, voiceOverride = null) {
  const tempDir = join(demoDir, 'tts-temp')
  await mkdir(tempDir, { recursive: true })
  const cacheIndex = await loadTtsCacheIndex()
  const engine = await resolveTtsEngineName()

  const audioFiles = []
  let cacheHits = 0
  let cacheMisses = 0
  for (const narration of narrations) {
    const effectiveVoice = getEffectiveTtsVoice({ narration, voiceOverride, engine })
    const cacheRecord = buildTtsCacheRecord({
      narration,
      engine,
      voice: effectiveVoice,
    })
    const cacheKey = buildTtsCacheKey(cacheRecord)
    const cacheFileName = `${cacheKey}.mp3`
    const outPath = join(DEMO_TTS_CACHE_DIR, cacheFileName)
    const existingEntry = cacheIndex.entries[cacheKey]

    if (existingEntry && existingEntry.file === cacheFileName && existsSync(outPath)) {
      cacheHits += 1
    } else {
      if (engine === 'google-cloud-text-to-speech') {
        const synthesizedWithGoogle = await synthesizeWithGoogleTts(narration, outPath, voiceOverride)
        if (!synthesizedWithGoogle) {
          throw new Error('Google-TTS wurde als Engine ausgewaehlt, konnte aber nicht ausgefuehrt werden.')
        }
      } else {
        await synthesizeWithFfmpegFlite(narration, outPath, tempDir)
      }
      cacheMisses += 1
    }

    cacheIndex.entries[cacheKey] = {
      ...cacheRecord,
      file: cacheFileName,
      hash: cacheKey,
      updatedAt: new Date().toISOString(),
    }

    audioFiles.push({
      ...narration,
      file: outPath,
    })
  }

  await writeTtsCacheIndex(cacheIndex)

  return {
    audioFiles,
    engine,
    cacheHits,
    cacheMisses,
    cacheDir: DEMO_TTS_CACHE_DIR,
  }
}

function outputPathWithSuffix(filePath, suffix) {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return `${filePath}${suffix}`
  return `${filePath.slice(0, dot)}${suffix}${filePath.slice(dot)}`
}

function getMediaDurationSeconds(filePath) {
  const output = runCommandWithOutput('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    filePath,
  ])
  const duration = Number.parseFloat(output.trim())
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Konnte Dauer nicht auslesen: ${filePath}`)
  }
  return duration
}

function getVideoDimensions(filePath) {
  const output = runCommandWithOutput('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
    filePath,
  ]).trim()

  const [widthRaw, heightRaw] = output.split('x')
  const width = Number.parseInt(widthRaw, 10)
  const height = Number.parseInt(heightRaw, 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Konnte Video-Groesse nicht auslesen: ${filePath}`)
  }

  return { width, height }
}

function hasAudioStream(filePath) {
  const output = runCommandWithOutput('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath,
  ]).trim()

  return output.length > 0
}

function escapeFfmpegDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
}

// Inserts full-screen title cards into the video at each step title position.
// Each card freezes the video, shows a white full-screen overlay with the title
// text (fade in/out), then continues. The step title atMs values must be in the
// post-annotation (post-click-hold) time space.
function insertStepTitleCardsIntoVideo({ inputVideo, outputVideo, stepTitles }) {
  const sortedStepTitles = [...stepTitles].sort((a, b) => a.atMs - b.atMs)
  if (sortedStepTitles.length === 0) {
    runCommand('ffmpeg', ['-y', '-i', inputVideo, '-c', 'copy', outputVideo])
    return
  }

  const videoDurationSec = getMediaDurationSeconds(inputVideo)
  const totalTitleDurationSec = sortedStepTitles.reduce(
    (sum, st) => sum + Math.max(1, st.durationMs / 1000), 0
  )
  const outputDurationSec = videoDurationSec + totalTitleDurationSec

  const filterParts = []
  const concatInputs = []
  let previousSec = 0
  let segmentIndex = 0

  for (const stepTitle of sortedStepTitles) {
    const atSec = Math.min(videoDurationSec, Math.max(previousSec, stepTitle.atMs / 1000))
    const durationSec = Math.max(1, stepTitle.durationMs / 1000)
    const fadeDurationSec = Math.min(DEMO_INTRO_FADE_DURATION_SEC, durationSec / 3)
    const endFadeSec = durationSec - fadeDurationSec

    // Video segment before the title card
    if (atSec > previousSec + 0.001) {
      const segLabel = `vseg${segmentIndex++}`
      filterParts.push(
        `[0:v]trim=start=${previousSec.toFixed(3)}:end=${atSec.toFixed(3)},setpts=PTS-STARTPTS[${segLabel}]`
      )
      concatInputs.push(`[${segLabel}]`)
    }

    // Freeze frame + full-screen white overlay + centered title + fade in/out
    let frameSrc = Math.max(0, Math.min(videoDurationSec - VIDEO_HOLD_FRAME_SLICE_SEC, atSec - VIDEO_HOLD_FRAME_LEAD_SEC))
    if (!Number.isFinite(frameSrc)) frameSrc = 0
    let frameEnd = Math.min(videoDurationSec, frameSrc + VIDEO_HOLD_FRAME_SLICE_SEC)
    if (!(frameEnd > frameSrc + 0.001)) {
      frameSrc = Math.max(0, videoDurationSec - VIDEO_HOLD_FRAME_SLICE_SEC)
      frameEnd = videoDurationSec
    }

    const titleLabel = `vtitle${segmentIndex++}`
    filterParts.push(
      `[0:v]trim=start=${frameSrc.toFixed(3)}:end=${frameEnd.toFixed(3)},` +
      `setpts=PTS-STARTPTS,` +
      `tpad=stop_mode=clone:stop_duration=${durationSec.toFixed(3)},` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill,` +
      `drawtext=text='${escapeFfmpegDrawtext(stepTitle.title)}':fontfile=${DEMO_TITLE_FONT}:fontsize=54:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2,` +
      `fade=t=in:st=0:d=${fadeDurationSec.toFixed(3)}:color=white,` +
      `fade=t=out:st=${endFadeSec.toFixed(3)}:d=${fadeDurationSec.toFixed(3)}:color=white` +
      `[${titleLabel}]`
    )
    concatInputs.push(`[${titleLabel}]`)
    previousSec = atSec
  }

  // Remaining segment after the last title card
  if (videoDurationSec > previousSec + 0.001) {
    const tailLabel = `vseg${segmentIndex++}`
    filterParts.push(
      `[0:v]trim=start=${previousSec.toFixed(3)}:end=${videoDurationSec.toFixed(3)},setpts=PTS-STARTPTS[${tailLabel}]`
    )
    concatInputs.push(`[${tailLabel}]`)
  }

  if (concatInputs.length === 0) {
    filterParts.push(`[0:v]null[vout]`)
  } else if (concatInputs.length === 1) {
    filterParts.push(`${concatInputs[0]}null[vout]`)
  } else {
    filterParts.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[vout]`)
  }

  runCommand('ffmpeg', [
    '-y', '-i', inputVideo,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-an',
    '-t', outputDurationSec.toFixed(3),
    outputVideo,
  ])
}

function prependIntroToVideo({ inputVideo, outputVideo, title = null, logoPath = DEMO_LOGO_PATH }) {
  if (!existsSync(logoPath)) {
    throw new Error(`Logo-Datei nicht gefunden: ${logoPath}`)
  }

  const { width, height } = getVideoDimensions(inputVideo)
  const inputDurationSec = getMediaDurationSeconds(inputVideo)
  const titleDurationSec = title ? DEMO_TITLE_INTRO_DURATION_SEC : 0
  const introDurationSec = DEMO_LOGO_INTRO_DURATION_SEC + titleDurationSec
  const outputDurationSec = inputDurationSec + introDurationSec
  const inputHasAudio = hasAudioStream(inputVideo)

  const args = [
    '-y',
    '-loop', '1',
    '-t', DEMO_LOGO_INTRO_DURATION_SEC.toFixed(3),
    '-i', logoPath,
  ]

  if (title) {
    args.push(
      '-f', 'lavfi',
      '-t', DEMO_TITLE_INTRO_DURATION_SEC.toFixed(3),
      '-i', `color=c=white:s=${width}x${height}:r=30`
    )
  }

  args.push(
    '-i', inputVideo,
    '-f', 'lavfi',
    '-t', outputDurationSec.toFixed(3),
    '-i', 'anullsrc=r=48000:cl=stereo',
  )

  const filterParts = [
    `[0:v]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=30,fade=t=out:st=${(DEMO_LOGO_INTRO_DURATION_SEC - DEMO_INTRO_FADE_DURATION_SEC).toFixed(3)}:d=${DEMO_INTRO_FADE_DURATION_SEC.toFixed(3)}:color=white,format=yuv420p[logov]`,
  ]

  const videoSegments = ['[logov]']
  const mainVideoInputIndex = title ? 2 : 1
  const silentAudioInputIndex = title ? 3 : 2

  if (title) {
    filterParts.push(
      `[1:v]drawtext=text='${escapeFfmpegDrawtext(title)}':fontfile=${DEMO_TITLE_FONT}:fontsize=54:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2,setsar=1,fade=t=in:st=0:d=${DEMO_INTRO_FADE_DURATION_SEC.toFixed(3)}:color=white,fade=t=out:st=${(DEMO_TITLE_INTRO_DURATION_SEC - DEMO_INTRO_FADE_DURATION_SEC).toFixed(3)}:d=${DEMO_INTRO_FADE_DURATION_SEC.toFixed(3)}:color=white,format=yuv420p[titlev]`
    )
    videoSegments.push('[titlev]')
  }

  filterParts.push(`[${mainVideoInputIndex}:v]fps=30,format=yuv420p[mainv]`)
  videoSegments.push('[mainv]')
  filterParts.push(`${videoSegments.join('')}concat=n=${videoSegments.length}:v=1:a=0[vout]`)

  if (inputHasAudio) {
    const delayMs = Math.round(introDurationSec * 1000)
    filterParts.push(`[${mainVideoInputIndex}:a]adelay=${delayMs}|${delayMs}[delayeda]`)
    filterParts.push(`[${silentAudioInputIndex}:a][delayeda]amix=inputs=2:duration=longest:dropout_transition=0[aout]`)
  } else {
    filterParts.push(`[${silentAudioInputIndex}:a]atrim=duration=${outputDurationSec.toFixed(3)},asetpts=PTS-STARTPTS[aout]`)
  }

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-t', outputDurationSec.toFixed(3),
    outputVideo,
  )

  runCommand('ffmpeg', args)
}

function normalizeNarrationTimeline(audioFiles) {
  const adjustedAudioFiles = []
  const pauses = []
  let cumulativeShiftMs = 0

  for (const entry of audioFiles) {
    const audioDurationMs = Math.max(0, Math.round((entry.durationSec || 0) * 1000))
    const windowMs = Math.max(0, Math.round(entry.endMs - entry.startMs))
    const overflowMs = Math.max(0, audioDurationMs - windowMs)
    const shiftBeforeMs = cumulativeShiftMs
    const shiftedStartMs = Math.max(0, Math.round(entry.startMs + cumulativeShiftMs))
    const shiftedWindowEndMs = Math.max(shiftedStartMs, Math.round(entry.endMs + shiftBeforeMs))
    const finalOutputEndMs = Math.max(shiftedStartMs, shiftedStartMs + audioDurationMs)

    adjustedAudioFiles.push({
      ...entry,
      windowMs,
      overflowMs,
      startMs: shiftedStartMs,
      shiftBeforeMs,
      audioDurationMs,
      shiftedWindowEndMs,
      pauseAtMs: null,
      finalOutputStartMs: shiftedStartMs,
      finalOutputEndMs,
    })

    if (overflowMs > 0) {
      // Pause anchors for video holds must stay in source-video time space
      // because muxNarrationAudioIntoVideo trims [0:v] on original timestamps.
      const anchor = String(entry?.sourceAnchor || '').trim().toLowerCase()
      const pauseAtMs = anchor === 'before'
        ? Math.max(0, Math.round(entry.startMs))
        : Math.max(0, Math.round(entry.endMs))
      pauses.push({
        atMs: pauseAtMs,
        durationMs: overflowMs,
      })
      adjustedAudioFiles[adjustedAudioFiles.length - 1].pauseAtMs = pauseAtMs
      cumulativeShiftMs += overflowMs
    }
  }

  return {
    adjustedAudioFiles,
    pauses,
    totalHoldMs: cumulativeShiftMs,
  }
}

function toSortedClickHoldRangesSec(clickHolds) {
  const ranges = []
  for (const hold of Array.isArray(clickHolds) ? clickHolds : []) {
    const atMs = Number(hold?.atMs)
    const durationMs = Number(hold?.durationMs)
    if (!Number.isFinite(atMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
      continue
    }
    ranges.push({
      startSec: Math.max(0, atMs / 1000),
      endSec: Math.max(0, (atMs + durationMs) / 1000),
    })
  }
  ranges.sort((left, right) => left.startSec - right.startSec)
  return ranges
}

function resolveMarkerFreePauseAnchorSec(pauseAtSec, videoDurationSec, clickHoldRangesSec) {
  let anchorSec = Math.max(0, pauseAtSec - VIDEO_HOLD_FRAME_LEAD_SEC)
  if (!Array.isArray(clickHoldRangesSec) || clickHoldRangesSec.length === 0) {
    return Math.min(videoDurationSec, anchorSec)
  }

  const epsilonSec = 0.001
  for (let guard = 0; guard < clickHoldRangesSec.length + 2; guard++) {
    const containingRange = clickHoldRangesSec.find(
      (range) => anchorSec >= range.startSec && anchorSec < range.endSec
    )
    if (!containingRange) {
      break
    }

    const beforeSec = containingRange.startSec - epsilonSec
    if (beforeSec >= 0) {
      anchorSec = beforeSec
      continue
    }

    const afterSec = containingRange.endSec + epsilonSec
    if (afterSec <= videoDurationSec) {
      anchorSec = afterSec
      continue
    }

    anchorSec = 0
    break
  }

  return Math.min(videoDurationSec, Math.max(0, anchorSec))
}

function muxNarrationAudioIntoVideo({ inputVideo, outputVideo, audioFiles, clickHolds = [] }) {
  const videoDurationSec = getMediaDurationSeconds(inputVideo)
  const clickHoldRangesSec = toSortedClickHoldRangesSec(clickHolds)
  const audioWithDuration = audioFiles.map((entry) => ({
    ...entry,
    durationSec: getMediaDurationSeconds(entry.file),
  }))
  const { adjustedAudioFiles, pauses, totalHoldMs } = normalizeNarrationTimeline(audioWithDuration)
  const outputDurationSec = videoDurationSec + (totalHoldMs / 1000)
  const ttsDebugAll = ['1', 'true', 'yes', 'on'].includes(String(process.env.SCENARIO_TTS_DEBUG || '').trim().toLowerCase())

  if (totalHoldMs > 0) {
    console.log(`Haltebilder eingefuegt: ${pauses.length}, Gesamtwartezeit: ${(totalHoldMs / 1000).toFixed(2)}s`)
  }

  if (ttsDebugAll || totalHoldMs > 0) {
    const debugRows = ttsDebugAll
      ? adjustedAudioFiles
      : adjustedAudioFiles.filter((entry) => Number(entry?.overflowMs || 0) > 0)

    if (debugRows.length > 0) {
      console.log('[tts-debug] Narration timeline diagnostics:')
      debugRows.forEach((entry) => {
        const id = String(entry?.id || '')
        const anchor = String(entry?.sourceAnchor || '')
        const plannedStartMs = Math.max(0, Math.floor(Number(entry?.startMs || 0) - Number(entry?.shiftBeforeMs || 0)))
        const plannedEndMs = Math.max(plannedStartMs, Math.floor(Number(entry?.endMs || plannedStartMs)))
        const shiftedStartMs = Math.max(0, Math.floor(Number(entry?.startMs || 0)))
        const shiftedWindowEndMs = Math.max(shiftedStartMs, Math.floor(Number(entry?.shiftedWindowEndMs || shiftedStartMs)))
        const windowMs = Math.max(0, Math.floor(Number(entry?.windowMs || 0)))
        const audioDurationMs = Math.max(0, Math.floor(Number(entry?.audioDurationMs || 0)))
        const overflowMs = Math.max(0, Math.floor(Number(entry?.overflowMs || 0)))
        const shiftBeforeMs = Math.max(0, Math.floor(Number(entry?.shiftBeforeMs || 0)))
        const pauseAtMs = entry?.pauseAtMs == null ? '-' : String(Math.max(0, Math.floor(Number(entry.pauseAtMs))))
        const pauseSec = entry?.pauseAtMs == null ? '-' : (Math.max(0, Number(entry.pauseAtMs)) / 1000).toFixed(3)

        console.log(
          `[tts-debug] id=${id} anchor=${anchor} planned=${plannedStartMs}-${plannedEndMs}ms shifted=${shiftedStartMs}-${shiftedWindowEndMs}ms window=${windowMs}ms audio=${audioDurationMs}ms overflow=${overflowMs}ms shiftBefore=${shiftBeforeMs}ms pauseAt=${pauseAtMs}ms(${pauseSec}s)`
        )
      })
    }
  }

  const args = ['-y', '-i', inputVideo, '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=stereo']
  adjustedAudioFiles.forEach((entry) => {
    args.push('-i', entry.file)
  })

  const filterParts = []
  const mixInputs = ['[1:a]']
  adjustedAudioFiles.forEach((entry, index) => {
    const inputIndex = index + 2
    const delay = Math.max(0, Math.floor(entry.startMs))
    const label = `n${index}`
    filterParts.push(`[${inputIndex}:a]adelay=${delay}|${delay},volume=1[${label}]`)
    mixInputs.push(`[${label}]`)
  })
  filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[aout]`)

  let hasVideoHolds = false
  if (pauses.length > 0) {
    hasVideoHolds = true
    const sortedPauses = [...pauses].sort((left, right) => left.atMs - right.atMs)
    const concatInputs = []
    let previousSec = 0
    let segmentIndex = 0

    for (const pause of sortedPauses) {
      const pauseAtSec = Math.min(videoDurationSec, Math.max(previousSec, pause.atMs / 1000))
      if (pauseAtSec > previousSec + 0.001) {
        const segmentLabel = `vseg${segmentIndex++}`
        filterParts.push(`[0:v]trim=start=${previousSec.toFixed(3)}:end=${pauseAtSec.toFixed(3)},setpts=PTS-STARTPTS[${segmentLabel}]`)
        concatInputs.push(`[${segmentLabel}]`)
      }

      const holdSec = Math.max(0, pause.durationMs / 1000)
      if (holdSec > 0.001) {
        const frameAnchorSec = resolveMarkerFreePauseAnchorSec(pauseAtSec, videoDurationSec, clickHoldRangesSec)
        let frameStart = Math.max(0, Math.min(videoDurationSec - VIDEO_HOLD_FRAME_SLICE_SEC, frameAnchorSec))
        if (!Number.isFinite(frameStart)) frameStart = 0
        let frameEnd = Math.min(videoDurationSec, frameStart + VIDEO_HOLD_FRAME_SLICE_SEC)
        if (!(frameEnd > frameStart + 0.001)) {
          frameStart = Math.max(0, videoDurationSec - VIDEO_HOLD_FRAME_SLICE_SEC)
          frameEnd = Math.max(frameStart + VIDEO_HOLD_FRAME_SLICE_SEC, videoDurationSec)
        }

        const holdLabel = `vhold${segmentIndex++}`
        filterParts.push(`[0:v]trim=start=${frameStart.toFixed(3)}:end=${frameEnd.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}[${holdLabel}]`)
        concatInputs.push(`[${holdLabel}]`)
      }

      previousSec = pauseAtSec
    }

    if (videoDurationSec > previousSec + 0.001) {
      const tailLabel = `vseg${segmentIndex++}`
      filterParts.push(`[0:v]trim=start=${previousSec.toFixed(3)}:end=${videoDurationSec.toFixed(3)},setpts=PTS-STARTPTS[${tailLabel}]`)
      concatInputs.push(`[${tailLabel}]`)
    }

    if (concatInputs.length === 0) {
      filterParts.push(`[0:v]trim=start=0:end=${videoDurationSec.toFixed(3)},setpts=PTS-STARTPTS[vout]`)
    } else if (concatInputs.length === 1) {
      filterParts.push(`${concatInputs[0]}null[vout]`)
    } else {
      filterParts.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[vout]`)
    }
  }

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', hasVideoHolds ? '[vout]' : '0:v',
    '-map', '[aout]',
    ...(hasVideoHolds ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] : ['-c:v', 'copy']),
    '-c:a', 'aac',
    '-t', outputDurationSec.toFixed(3),
    outputVideo,
  )

  runCommand('ffmpeg', args)

  return {
    adjustedAudioFiles,
    pauses,
    totalHoldMs,
    outputDurationSec,
  }
}

function buildScenarioTtsDiagnosticsLog({
  scenarioPath,
  profileName,
  sourceVideo,
  outputVideo,
  totalHoldMs,
  pauses,
  resolvedNarrations,
  adjustedById,
}) {
  const lines = []
  lines.push(`# TTS Diagnostics`)
  lines.push(`generatedAt=${new Date().toISOString()}`)
  lines.push(`scenarioPath=${scenarioPath}`)
  lines.push(`profile=${profileName}`)
  lines.push(`sourceVideo=${sourceVideo}`)
  lines.push(`outputVideo=${outputVideo}`)
  lines.push(`totalHoldMs=${Math.max(0, Math.floor(Number(totalHoldMs) || 0))}`)
  lines.push(`pauseCount=${Array.isArray(pauses) ? pauses.length : 0}`)
  lines.push('')
  lines.push('[pauses]')

  for (const pause of Array.isArray(pauses) ? pauses : []) {
    const atMs = Math.max(0, Math.floor(Number(pause?.atMs) || 0))
    const durationMs = Math.max(0, Math.floor(Number(pause?.durationMs) || 0))
    lines.push(`pause atMs=${atMs} durationMs=${durationMs}`)
  }

  lines.push('')
  lines.push('[narrations]')

  for (const narration of Array.isArray(resolvedNarrations) ? resolvedNarrations : []) {
    const id = String(narration?.id || '')
    const adjusted = adjustedById.get(id) || null
    const clipStartMs = Math.max(0, Math.floor(Number(narration?.clipVideoStartMs || narration?.startMs || 0)))
    const clipEndMs = Math.max(clipStartMs, Math.floor(Number(narration?.clipVideoEndMs || narration?.endMs || clipStartMs)))
    const finalStartMs = Math.max(0, Math.floor(Number(narration?.finalInsertedStartMs || clipStartMs)))
    const finalEndMs = Math.max(finalStartMs, Math.floor(Number(narration?.finalInsertedEndMs || clipEndMs)))

    const windowMs = adjusted ? Math.max(0, Math.floor(Number(adjusted.windowMs || 0))) : Math.max(0, clipEndMs - clipStartMs)
    const audioDurationMs = adjusted ? Math.max(0, Math.floor(Number(adjusted.audioDurationMs || 0))) : 0
    const overflowMs = adjusted ? Math.max(0, Math.floor(Number(adjusted.overflowMs || 0))) : 0
    const shiftBeforeMs = adjusted ? Math.max(0, Math.floor(Number(adjusted.shiftBeforeMs || 0))) : 0
    const pauseAtMs = adjusted && adjusted.pauseAtMs != null
      ? Math.max(0, Math.floor(Number(adjusted.pauseAtMs) || 0))
      : null

    lines.push([
      `id=${id}`,
      `anchor=${String(narration?.sourceAnchor || '')}`,
      `sourceTimelineStepId=${String(narration?.sourceTimelineStepId || '')}`,
      `sourceScenarioStepId=${String(narration?.sourceScenarioStepId || '')}`,
      `clip=${clipStartMs}-${clipEndMs}`,
      `final=${finalStartMs}-${finalEndMs}`,
      `windowMs=${windowMs}`,
      `audioDurationMs=${audioDurationMs}`,
      `overflowMs=${overflowMs}`,
      `shiftBeforeMs=${shiftBeforeMs}`,
      `pauseAtMs=${pauseAtMs == null ? '-' : String(pauseAtMs)}`,
    ].join(' | '))
  }

  return `${lines.join('\n')}\n`
}

async function collectArtifactDirs(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true })
  const dirs = []

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      dirs.push(fullPath)
      dirs.push(...await collectArtifactDirs(fullPath))
    }
  }

  return dirs
}

async function findArtifactPair(outputDir) {
  if (!existsSync(outputDir)) return null

  const dirs = [outputDir, ...await collectArtifactDirs(outputDir)]
  const candidates = []

  for (const dir of dirs) {
    const tracePath = join(dir, 'trace.zip')
    const videoPath = join(dir, 'video.webm')
    if (!existsSync(tracePath) || !existsSync(videoPath)) continue

    const traceStat = await stat(tracePath)
    candidates.push({
      dir,
      tracePath,
      videoPath,
      mtimeMs: traceStat.mtimeMs,
    })
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0] || null
}

async function findLatestArtifactsForTestFile(testFile) {
  const testBaseName = basename(testFile).replace(/\.[^.]+$/, '')
  const testToken = sanitizeFileToken(testBaseName)
  const testRunsRoot = join(OUTPUT_MANUAL_RUNS_ROOT, testToken)
  if (!existsSync(testRunsRoot)) {
    return null
  }

  const runDirEntries = await readdir(testRunsRoot, { withFileTypes: true })
  const runIds = runDirEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))

  for (const runId of runIds) {
    const outputDir = join(testRunsRoot, runId)
    const artifactsDir = join(outputDir, 'artifacts')
    const artifactPair = await findArtifactPair(artifactsDir)
    if (!artifactPair) continue
    const demoDir = join(artifactPair.dir, 'demo')
    if (!existsSync(demoDir)) continue

    const finalDir = join(outputDir, 'final')
    const defaultVideo = join(finalDir, `${testToken}-annotated-${runId}.mp4`)
    const previousOutputVideo = existsSync(defaultVideo)
      ? defaultVideo
      : join(finalDir, `${testToken}-annotated.mp4`)

    return {
      runId,
      outputDir,
      tracePath: artifactPair.tracePath,
      inputVideo: artifactPair.videoPath,
      demoDir,
      previousOutputVideo,
    }
  }

  return null
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })

  if (result.error) {
    throw result.error
  }

  return result.status ?? 1
}

async function buildAnnotatedArtifacts({
  tracePath,
  inputVideo,
  demoDir,
  resolvedOutputVideo,
  tts = false,
  ttsVoice = null,
}) {
  const resolvedTracePath = resolve(tracePath)
  const resolvedInputVideo = resolve(inputVideo)
  const resolvedDemoDir = resolve(demoDir)

  if (!existsSync(resolvedTracePath)) {
    throw new Error(`Trace nicht gefunden: ${tracePath}`)
  }
  if (!existsSync(resolvedInputVideo)) {
    throw new Error(`Video nicht gefunden: ${inputVideo}`)
  }
  if (!existsSync(resolvedDemoDir)) {
    throw new Error(`Demo-Verzeichnis nicht gefunden: ${demoDir}`)
  }

  const videoClip = await resolveVideoClipFromDemoDir(resolvedDemoDir)
  const introlessOutputVideo = outputPathWithSuffix(resolvedOutputVideo, '-raw')
  const annotateArgs = [
    'scripts/annotate-video-from-trace.mjs',
    resolvedTracePath,
    resolvedInputVideo,
    introlessOutputVideo,
    `--clip-start-ms=${videoClip.startMs}`,
  ]
  if (videoClip.endMs !== null) {
    annotateArgs.push(`--clip-end-ms=${videoClip.endMs}`)
  }

  console.log('Erzeuge annotiertes Video...')
  const annotateExitCode = runCommand('node', annotateArgs)
  if (annotateExitCode !== 0) {
    process.exit(annotateExitCode)
  }
  const annotateMeta = await readAnnotateMetaIfExists(introlessOutputVideo)

  // Resolve step titles (atMs in original clip-relative time, before click-hold shift)
  const rawStepTitles = await resolveStepTitlesFromDemoDir(resolvedDemoDir)

  // For video insertion the click holds are already baked into introlessOutputVideo,
  // so step title atMs must be shifted to post-click-hold time space.
  const stepTitlesForInsertion = rawStepTitles.map((st) => ({
    ...st,
    atMs: applyClickHoldShift(st.atMs, annotateMeta.clickHolds),
  }))

  // Insert step title freeze-frame cards into the annotated video
  let introlessVideoWithTitles = introlessOutputVideo
  if (rawStepTitles.length > 0) {
    introlessVideoWithTitles = outputPathWithSuffix(resolvedOutputVideo, '-raw-titled')
    console.log(`Fuge ${rawStepTitles.length} Step-Title-Einblendung(en) ein...`)
    insertStepTitleCardsIntoVideo({
      inputVideo: introlessOutputVideo,
      outputVideo: introlessVideoWithTitles,
      stepTitles: stepTitlesForInsertion,
    })
  }

  console.log('Setze Logo-Intro vor das annotierte Video...')
  const videoTitle = await resolveVideoTitleFromDemoDir(resolvedDemoDir)
  prependIntroToVideo({
    inputVideo: introlessVideoWithTitles,
    outputVideo: resolvedOutputVideo,
    title: videoTitle,
  })

  if (tts) {
    // Narration times must be shifted by both click holds AND step title holds.
    // Both are expressed in original clip-relative time, so they can be combined.
    const stepTitleHolds = rawStepTitles.map((st) => ({ atMs: st.atMs, durationMs: st.durationMs }))
    const combinedHolds = [...(annotateMeta.clickHolds || []), ...stepTitleHolds]
    const stepTitleHoldsForInsertion = stepTitlesForInsertion.map((st) => ({ atMs: st.atMs, durationMs: st.durationMs }))
    const clickHoldsForMux = (annotateMeta.clickHolds || []).map((hold) => ({
      ...hold,
      atMs: applyClickHoldShift(Number(hold?.atMs || 0), stepTitleHoldsForInsertion),
    }))

    console.log('Verarbeite Demo-Timeline fuer TTS...')
    const resolvedNarrations = await resolveNarrationsFromDemoDir(resolvedDemoDir, {
      clickHolds: combinedHolds,
    })
    if (resolvedNarrations.length === 0) {
      throw new Error('TTS angefordert, aber keine Narrationsdefinitionen gefunden.')
    }

    const { audioFiles, engine, cacheHits, cacheMisses, cacheDir } = await synthesizeNarrations(resolvedDemoDir, resolvedNarrations, ttsVoice)
    console.log(`TTS-Engine: ${engine}. Narrationsdateien: ${audioFiles.length}. Cache: ${cacheHits} Treffer, ${cacheMisses} neu erzeugt (${cacheDir})`)

    const outputWithTts = outputPathWithSuffix(resolvedOutputVideo, '-tts')
    const outputWithTtsRaw = outputPathWithSuffix(outputWithTts, '-raw')
    console.log('Mische Voiceover in das annotierte Video...')
    muxNarrationAudioIntoVideo({
      inputVideo: introlessVideoWithTitles,
      outputVideo: outputWithTtsRaw,
      audioFiles,
      clickHolds: clickHoldsForMux,
    })
    console.log('Setze Logo-Intro vor das Voiceover-Video...')
    prependIntroToVideo({
      inputVideo: outputWithTtsRaw,
      outputVideo: outputWithTts,
      title: videoTitle,
    })
    console.log(`Voiceover-Video bereit: ${outputWithTts}`)
  }

  console.log(`\nAnnotiertes Video bereit: ${resolvedOutputVideo}`)
}

function sanitizeFileToken(value) {
  return String(value || 'output')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'output'
}

function sanitizeScenarioVersionForFolder(value) {
  let normalized = value

  if (typeof normalized === 'number' && Number.isFinite(normalized)) {
    if (Number.isInteger(normalized)) {
      normalized = `${normalized}.0`
    } else {
      normalized = String(normalized)
    }
  }

  return String(normalized || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/\./g, '_')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

function buildScenarioOutputFolderName({ scenarioId, scenarioVersion }) {
  const idToken = sanitizeFileToken(scenarioId || 'scenario')
  const versionToken = sanitizeScenarioVersionForFolder(scenarioVersion || 'unknown')
  return `${idToken}_v${versionToken}`
}

async function runScenarioTtsMode({ scenarioPath, profileName, outputVideo, ttsVoice = null }) {
  const central = loadCentralConfig(process.cwd())
  const scenarioAbsolutePath = resolve(scenarioPath)
  if (!existsSync(scenarioAbsolutePath)) {
    throw new Error(`Szenario-Datei nicht gefunden: ${scenarioPath}`)
  }

  const scenarioPathRelative = normalizeWorkspaceRelativePath(scenarioPath)
  const profile = resolveScenarioTtsProfile(central.config, profileName)

  const scenarioRaw = await readFile(scenarioAbsolutePath, 'utf8')
  const scenarioParsed = parseYaml(scenarioRaw) || {}
  const scenarioRoot = scenarioParsed.interaction || scenarioParsed
  if (!scenarioRoot || typeof scenarioRoot !== 'object') {
    throw new Error('Ungueltiges Szenario: interaction-Root fehlt.')
  }

  const artifacts = await ensureScenarioVideoTimelinePair({
    scenarioPathRelative,
  })

  await assertScenarioMatchesRawVideoIgnoringPresentation({
    scenarioAbsolutePath,
    scenarioPathRelative,
    artifactsDir: artifacts.dir,
  })

  const narrations = buildNarrationsFromScenarioTimeline({
    scenarioRoot,
    timelineReport: artifacts.timeline,
    profile,
    voiceOverride: ttsVoice,
  })

  const presentationRange = resolveScenarioPresentationVideoRangeFromTimeline({
    scenarioRoot,
    timelineReport: artifacts.timeline,
  })

  const profileToken = sanitizeFileToken(profileName)
  const scenarioToken = sanitizeFileToken(basename(scenarioPathRelative).replace(/\.[^.]+$/, ''))
  const runId = toRunId()
  const scenarioFolderName = buildScenarioOutputFolderName({
    scenarioId: scenarioRoot.id || scenarioToken,
    scenarioVersion: scenarioRoot.version || 'unknown',
  })
  const scenarioOutputRoot = join(OUTPUT_ROOT, scenarioFolderName)
  const ttsOutputDir = join(scenarioOutputRoot, 'tts')
  const resolvedOutputVideo = outputVideo
    ? resolve(outputVideo)
    : join(ttsOutputDir, `${scenarioToken}-${profileToken}-tts-${runId}.mp4`)

  await mkdir(dirname(resolvedOutputVideo), { recursive: true })
  await mkdir(ttsOutputDir, { recursive: true })

  let effectiveNarrations = narrations
  const rawChapterTitles = buildScenarioChapterTitlesFromTimeline({
    scenarioRoot,
    timelineReport: artifacts.timeline,
    presentationRange,
  })
  if (presentationRange) {
    const clipStartMs = Math.max(0, Number(presentationRange.startMs) || 0)
    const clipEndMs = presentationRange.endMs == null ? null : Math.max(0, Number(presentationRange.endMs) || 0)
    const startDirectiveStepId = String(presentationRange.startDirectiveStepId || '').trim()

    effectiveNarrations = narrations
      .map((entry) => {
        const sourceStartMs = Number(entry.startMs)
        const sourceEndMs = Number(entry.endMs)
        if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs)) {
          return null
        }

        const clippedStartMs = Math.max(sourceStartMs, clipStartMs)
        const clippedEndMs = clipEndMs == null ? sourceEndMs : Math.min(sourceEndMs, clipEndMs)
        if (clippedEndMs <= clippedStartMs) {
          const sourceScenarioStepId = String(entry.sourceScenarioStepId || '').trim()
          const sourceAnchor = String(entry.sourceAnchor || '').trim()
          const shouldKeepBoundaryBeforeNarration = Boolean(
            clipStartMs > 0
            && startDirectiveStepId
            && sourceAnchor === 'before'
            && sourceScenarioStepId === startDirectiveStepId,
          )

          if (shouldKeepBoundaryBeforeNarration) {
            const sourceDurationMs = Math.max(1, Math.floor(sourceEndMs - sourceStartMs))
            const maxWindowMs = clipEndMs == null ? sourceDurationMs : Math.max(1, Math.floor(clipEndMs - clipStartMs))
            return {
              ...entry,
              startMs: 0,
              endMs: Math.max(1, Math.min(sourceDurationMs, maxWindowMs)),
            }
          }

          return null
        }

        return {
          ...entry,
          startMs: Math.max(0, Math.floor(clippedStartMs - clipStartMs)),
          endMs: Math.max(1, Math.floor(clippedEndMs - clipStartMs)),
        }
      })
      .filter(Boolean)

  }

  const clickIndicatorConfig = resolveScenarioClickIndicatorConfig(scenarioRoot)

  let sourceVideoForTts = presentationRange
    ? join(ttsOutputDir, `${scenarioToken}-${profileToken}-clip-${runId}.mp4`)
    : artifacts.videoPath
  let clickAnnotateMeta = { clickHolds: [] }

  const resolveClickIndicatorImagePath = (rawImagePath) => {
    if (!rawImagePath || typeof rawImagePath !== 'string') {
      return null
    }

    const normalized = rawImagePath.trim()
    if (!normalized) {
      return null
    }

    if (normalized.startsWith('/')) {
      return normalized
    }

    const workspaceCandidate = resolve(normalized)
    if (existsSync(workspaceCandidate)) {
      return workspaceCandidate
    }

    return resolve(dirname(scenarioAbsolutePath), normalized)
  }

  const tracePath = join(artifacts.dir, 'trace.zip')
  if (clickIndicatorConfig?.enabled === true && existsSync(tracePath)) {
    const clickAnnotatedVideo = join(ttsOutputDir, `${scenarioToken}-${profileToken}-click-${runId}.mp4`)
    const annotateArgs = [
      'scripts/annotate-video-from-trace.mjs',
      tracePath,
      artifacts.videoPath,
      clickAnnotatedVideo,
    ]

    if (presentationRange) {
      annotateArgs.push(`--clip-start-ms=${Math.max(0, Number(presentationRange.startMs) || 0)}`)
      if (presentationRange.endMs != null) {
        annotateArgs.push(`--clip-end-ms=${Math.max(0, Number(presentationRange.endMs) || 0)}`)
      }
    }

    const clickIndicatorImagePath = resolveClickIndicatorImagePath(clickIndicatorConfig.image)
    annotateArgs.push(...buildAnnotateClickIndicatorArgs({
      ...clickIndicatorConfig,
      image: clickIndicatorImagePath,
    }))

    const annotateExitCode = runCommand('node', annotateArgs)
    if (annotateExitCode !== 0) {
      throw new Error(`Klick-Indikator-Annotation fehlgeschlagen (Exit-Code ${annotateExitCode}).`)
    }

    sourceVideoForTts = clickAnnotatedVideo
    clickAnnotateMeta = await readAnnotateMetaIfExists(clickAnnotatedVideo)
  } else if (presentationRange) {
    cutVideoToRange({
      inputVideo: artifacts.videoPath,
      outputVideo: sourceVideoForTts,
      startMs: presentationRange.startMs,
      endMs: presentationRange.endMs,
    })
  }

  if (presentationRange) {
    const presentationMetaPath = join(ttsOutputDir, `yaml-presentation-range-${profileToken}-${runId}.json`)
    await writeFile(presentationMetaPath, JSON.stringify({
      sourceVideo: artifacts.videoPath,
      clippedVideo: sourceVideoForTts,
      startMs: presentationRange.startMs,
      endMs: presentationRange.endMs,
      directives: presentationRange.directives,
    }, null, 2), 'utf8')
  }

  const clickHolds = Array.isArray(clickAnnotateMeta?.clickHolds) ? clickAnnotateMeta.clickHolds : []
  if (clickHolds.length > 0) {
    effectiveNarrations = effectiveNarrations
      .map((entry) => {
        const startMs = Number(entry?.startMs)
        const endMs = Number(entry?.endMs)
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
          return null
        }

        return {
          ...entry,
          startMs: applyClickHoldShift(startMs, clickHolds),
          endMs: applyClickHoldShift(endMs, clickHolds),
        }
      })
      .filter(Boolean)
  }

  const chapterTitlesForInsertion = rawChapterTitles.map((entry) => ({
    ...entry,
    atMs: applyClickHoldShift(entry.atMs, clickHolds),
  }))
  const chapterHoldsForInsertion = chapterTitlesForInsertion.map((entry) => ({
    atMs: entry.atMs,
    durationMs: entry.durationMs,
  }))

  if (chapterHoldsForInsertion.length > 0) {
    effectiveNarrations = effectiveNarrations
      .map((entry) => {
        const startMs = Number(entry?.startMs)
        const endMs = Number(entry?.endMs)
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
          return null
        }

        return {
          ...entry,
          startMs: applyClickHoldShift(startMs, chapterHoldsForInsertion),
          endMs: applyClickHoldShift(endMs, chapterHoldsForInsertion),
        }
      })
      .filter(Boolean)
  }

  let clickHoldsForMux = clickHolds
  if (clickHolds.length > 0 && chapterHoldsForInsertion.length > 0) {
    clickHoldsForMux = clickHolds.map((hold) => ({
      ...hold,
      atMs: applyClickHoldShift(Number(hold?.atMs || 0), chapterHoldsForInsertion),
    }))
  }

  if (chapterTitlesForInsertion.length > 0) {
    const chapterVideo = join(ttsOutputDir, `${scenarioToken}-${profileToken}-chapter-${runId}.mp4`)
    console.log(`Fuge ${chapterTitlesForInsertion.length} Kapitelkarte(n) ein...`)
    insertStepTitleCardsIntoVideo({
      inputVideo: sourceVideoForTts,
      outputVideo: chapterVideo,
      stepTitles: chapterTitlesForInsertion,
    })
    sourceVideoForTts = chapterVideo
  }

  if (!effectiveNarrations.length) {
    console.log(`[scenario-tts] Keine Didactics fuer Profil "${profileName}" gefunden. Es wird ohne Voiceover exportiert.`)

    const outputWithoutTts = resolvedOutputVideo
    runCommand('cp', [sourceVideoForTts, outputWithoutTts])

    console.log(`Profil-Video ohne Voiceover bereit: ${outputWithoutTts}`)
    return
  }

  const { audioFiles, engine, cacheHits, cacheMisses, cacheDir } = await synthesizeNarrations(artifacts.dir, effectiveNarrations, ttsVoice)
  console.log(`TTS-Engine: ${engine}. Narrationsdateien: ${audioFiles.length}. Cache: ${cacheHits} Treffer, ${cacheMisses} neu erzeugt (${cacheDir})`)

  console.log(`Mische Profil-Voiceover in Video: ${sourceVideoForTts}`)
  const muxMeta = muxNarrationAudioIntoVideo({
    inputVideo: sourceVideoForTts,
    outputVideo: resolvedOutputVideo,
    audioFiles,
    clickHolds: clickHoldsForMux,
  })

  const clipOffsetMs = presentationRange ? Math.max(0, Number(presentationRange.startMs) || 0) : 0
  const adjustedByNarrationId = new Map(
    (muxMeta?.adjustedAudioFiles || []).map((entry) => [String(entry.id || ''), entry])
  )
  const resolvedNarrationsForExport = effectiveNarrations.map((entry) => {
    const adjusted = adjustedByNarrationId.get(String(entry.id || '')) || null
    const clipVideoStartMs = Math.max(0, Number(entry.startMs) || 0)
    const clipVideoEndMs = Math.max(clipVideoStartMs, Number(entry.endMs) || clipVideoStartMs)
    const finalInsertedStartMs = adjusted
      ? Math.max(0, Number(adjusted.finalOutputStartMs) || 0)
      : clipVideoStartMs
    const finalInsertedEndMs = adjusted
      ? Math.max(finalInsertedStartMs, Number(adjusted.finalOutputEndMs) || finalInsertedStartMs)
      : clipVideoEndMs

    return {
      ...entry,
      clipVideoStartMs,
      clipVideoEndMs,
      originalVideoStartMs: clipOffsetMs + clipVideoStartMs,
      originalVideoEndMs: clipOffsetMs + clipVideoEndMs,
      finalInsertedStartMs,
      finalInsertedEndMs,
    }
  })

  const resolvedTimelinePath = join(ttsOutputDir, `yaml-tts-resolved-${profileToken}-${runId}.json`)
  await writeFile(resolvedTimelinePath, JSON.stringify(resolvedNarrationsForExport, null, 2), 'utf8')

  const diagnosticsLogPath = join(ttsOutputDir, `yaml-tts-debug-${profileToken}-${runId}.log`)
  const diagnosticsLog = buildScenarioTtsDiagnosticsLog({
    scenarioPath: scenarioPathRelative,
    profileName,
    sourceVideo: sourceVideoForTts,
    outputVideo: resolvedOutputVideo,
    totalHoldMs: muxMeta?.totalHoldMs,
    pauses: muxMeta?.pauses,
    resolvedNarrations: resolvedNarrationsForExport,
    adjustedById: adjustedByNarrationId,
  })
  await writeFile(diagnosticsLogPath, diagnosticsLog, 'utf8')

  console.log(`Aufgeloeste Narrations-Timeline: ${resolvedTimelinePath}`)
  console.log(`TTS-Diagnose-Log: ${diagnosticsLogPath}`)
  console.log(`Profil-Voiceover-Video bereit: ${resolvedOutputVideo}`)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    printUsage()
    return
  }

  if (parsed.scenarioTts) {
    await runScenarioTtsMode({
      scenarioPath: parsed.scenarioPath,
      profileName: parsed.profile,
      outputVideo: parsed.outputVideo,
      ttsVoice: parsed.ttsVoice,
    })
    return
  }

  if (parsed.rerender) {
    const latestArtifacts = await findLatestArtifactsForTestFile(parsed.testFile)
    if (!latestArtifacts) {
      throw new Error(`Keine frueheren Artefakte fuer ${parsed.testFile} gefunden.`)
    }

    const resolvedOutputVideo = parsed.outputVideo
      ? resolve(parsed.outputVideo)
      : latestArtifacts.previousOutputVideo

    await buildAnnotatedArtifacts({
      tracePath: latestArtifacts.tracePath,
      inputVideo: latestArtifacts.inputVideo,
      demoDir: latestArtifacts.demoDir,
      resolvedOutputVideo,
      tts: parsed.tts,
      ttsVoice: parsed.ttsVoice,
    })
    return
  }

  if (parsed.annotateOnly) {
    const runId = toRunId()
    const annotateToken = sanitizeFileToken(basename(parsed.inputVideo).replace(/\.[^.]+$/, 'video'))
    const defaultOutput = join(
      OUTPUT_MANUAL_RUNS_ROOT,
      'annotate-only',
      runId,
      'final',
      `${annotateToken}-annotated-${runId}.mp4`
    )
    const resolvedOutputVideo = parsed.outputVideo ? resolve(parsed.outputVideo) : defaultOutput
    await buildAnnotatedArtifacts({
      tracePath: parsed.tracePath,
      inputVideo: parsed.inputVideo,
      demoDir: parsed.demoDir,
      resolvedOutputVideo,
      tts: parsed.tts,
      ttsVoice: parsed.ttsVoice,
    })
    return
  }

  if (parsed.ttsOnly) {
    const resolvedInputVideo = resolve(parsed.inputVideo)
    if (!existsSync(resolvedInputVideo)) {
      throw new Error(`Annotiertes Video nicht gefunden: ${parsed.inputVideo}`)
    }

    const resolvedDemoDir = resolve(parsed.demoDir)
    if (!existsSync(resolvedDemoDir)) {
      throw new Error(`Demo-Verzeichnis nicht gefunden: ${parsed.demoDir}`)
    }

    const annotateMeta = await readAnnotateMetaIfExists(resolvedInputVideo)
    console.log('Verarbeite Demo-Timeline fuer TTS (ohne neuen Testlauf)...')
    const rawStepTitlesTtsOnly = await resolveStepTitlesFromDemoDir(resolvedDemoDir)
    const stepTitleHoldsTtsOnly = rawStepTitlesTtsOnly.map((st) => ({ atMs: st.atMs, durationMs: st.durationMs }))
    const combinedHoldsTtsOnly = [...(annotateMeta.clickHolds || []), ...stepTitleHoldsTtsOnly]
    const resolvedNarrations = await resolveNarrationsFromDemoDir(resolvedDemoDir, {
      clickHolds: combinedHoldsTtsOnly,
    })
    if (resolvedNarrations.length === 0) {
      throw new Error('TTS angefordert, aber keine Narrationsdefinitionen gefunden.')
    }

    const { audioFiles, engine, cacheHits, cacheMisses, cacheDir } = await synthesizeNarrations(resolvedDemoDir, resolvedNarrations, parsed.ttsVoice)
    console.log(`TTS-Engine: ${engine}. Narrationsdateien: ${audioFiles.length}. Cache: ${cacheHits} Treffer, ${cacheMisses} neu erzeugt (${cacheDir})`)

    const outputWithTts = parsed.outputVideo
      ? resolve(parsed.outputVideo)
      : outputPathWithSuffix(resolvedInputVideo, '-tts')
    console.log('Mische Voiceover in das annotierte Video...')
    muxNarrationAudioIntoVideo({
      inputVideo: resolvedInputVideo,
      outputVideo: outputWithTts,
      audioFiles,
      clickHolds: annotateMeta.clickHolds || [],
    })
    console.log(`Voiceover-Video bereit: ${outputWithTts}`)
    return
  }

  const { testFile, outputVideo, slowMo, tts, ttsVoice, playwrightArgs } = parsed
  const resolvedTestFile = resolve(testFile)
  if (!existsSync(resolvedTestFile)) {
    throw new Error(`Testfile nicht gefunden: ${testFile}`)
  }

  const runId = toRunId()
  const testToken = sanitizeFileToken(basename(testFile).replace(/\.[^.]+$/, 'test'))
  const runRootDir = join(OUTPUT_MANUAL_RUNS_ROOT, testToken, runId)
  const outputDir = join(runRootDir, 'artifacts')
  await mkdir(outputDir, { recursive: true })
  const derivedTestTimeout = Math.max(600_000, 60_000 + (slowMo * 120))

  const defaultOutput = join(
    runRootDir,
    'final',
    `${testToken}-annotated-${runId}.mp4`
  )
  const resolvedOutputVideo = outputVideo ? resolve(outputVideo) : defaultOutput
  const introlessOutputVideo = outputPathWithSuffix(resolvedOutputVideo, '-raw')

  await mkdir(dirname(resolvedOutputVideo), { recursive: true })
  await mkdir(dirname(introlessOutputVideo), { recursive: true })

  const playwrightCommand = [
    'playwright',
    'test',
    resolvedTestFile,
    '--trace',
    'on',
    '--output',
    outputDir,
    ...playwrightArgs,
  ]

  console.log(`Starte Playwright-Lauf mit Trace, slowMo=${slowMo}ms und timeout=${derivedTestTimeout}ms...`)
  const testExitCode = runCommand('npx', playwrightCommand, {
    env: {
      ...process.env,
      PW_SLOWMO: String(slowMo),
      PW_TEST_TIMEOUT: String(derivedTestTimeout),
      PW_VIDEO_SIZE: '1920x1080',
    },
  })
  if (testExitCode !== 0) {
    process.exit(testExitCode)
  }

  const artifactPair = await findArtifactPair(outputDir)
  if (!artifactPair) {
    throw new Error(`Kein Paar aus trace.zip und video.webm unter ${outputDir} gefunden.`)
  }

  console.log(`Gefundener Trace: ${artifactPair.tracePath}`)
  console.log(`Gefundenes Video: ${artifactPair.videoPath}`)

  await buildAnnotatedArtifacts({
    tracePath: artifactPair.tracePath,
    inputVideo: artifactPair.videoPath,
    demoDir: join(artifactPair.dir, 'demo'),
    resolvedOutputVideo,
    tts,
    ttsVoice,
  })

  const runMetaPath = join(runRootDir, 'run-meta.json')
  await writeFile(runMetaPath, JSON.stringify({
    createdAtIso: new Date().toISOString(),
    runId,
    mode: 'manual-annotated-video',
    testFile: normalizeWorkspaceRelativePath(testFile),
    artifactDir: normalizeWorkspaceRelativePath(relative(process.cwd(), outputDir)),
    outputVideo: normalizeWorkspaceRelativePath(relative(process.cwd(), resolvedOutputVideo)),
    outputVideoRaw: normalizeWorkspaceRelativePath(relative(process.cwd(), introlessOutputVideo)),
  }, null, 2), 'utf8')
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
