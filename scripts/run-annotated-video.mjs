#!/usr/bin/env node

import { existsSync } from 'fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { parse as parseYaml } from 'yaml'
import { loadCentralConfig } from './shared/central-config.mjs'

const DEMO_LOGO_PATH = resolve('demo', 'img', 'lunettes.png')
const DEMO_LOGO_INTRO_DURATION_SEC = 2
const DEMO_TITLE_INTRO_DURATION_SEC = 2
const DEMO_TITLE_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const DEMO_INTRO_FADE_DURATION_SEC = 0.4
const DEMO_STEP_TITLE_DURATION_MS = 2000
const DEMO_TTS_CACHE_DIR = resolve('temp', 'tts')
const DEMO_TTS_INDEX_PATH = join(DEMO_TTS_CACHE_DIR, 'index.json')
const VIDEO_HOLD_FRAME_SLICE_SEC = 0.04
const VIDEO_HOLD_FRAME_LEAD_SEC = 0.08
const DEFAULT_SLOWMO_MS = 1000

let googleTtsModulePromise

function printUsage() {
  console.log(`Verwendung:
  node scripts/run-annotated-video.mjs --scenario-tts <scenario.yaml> --profile=<profil> [output.mp4] [--force-video] [--tts-voice=<name>]
  node scripts/run-annotated-video.mjs <testfile> [output.mp4] [--slowmo=<ms>] [--tts] [--tts-voice=<name>] [weitere Playwright-Argumente]
  node scripts/run-annotated-video.mjs --rerender <testfile> [output.mp4] [--tts] [--tts-voice=<name>]
  node scripts/run-annotated-video.mjs --annotate-only <trace.zip> <video.webm> <demoDir> [output.mp4] [--tts] [--tts-voice=<name>]
  node scripts/run-annotated-video.mjs --tts-only <annotated.mp4> <demoDir> [output-tts.mp4] [--tts-voice=<name>]

Beispiele:
  node scripts/run-annotated-video.mjs --scenario-tts lunettes/tests/login.yaml --profile=training-basic
  node scripts/run-annotated-video.mjs --scenario-tts lunettes/tests/login.yaml --profile=training-basic --force-video
  node scripts/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js
  node scripts/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js --slowmo=1000
  node scripts/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js annotated.mp4 --project=chromium
  node scripts/run-annotated-video.mjs --rerender tests/e2e/idee-flow.spec.js --tts
  node scripts/run-annotated-video.mjs --annotate-only ../test-artifacts/run/demo/trace.zip ../test-artifacts/run/demo/video.webm ../test-artifacts/run/demo annotated.mp4 --tts
  node scripts/run-annotated-video.mjs tests/e2e/idee-flow.spec.js --project=chromium --tts
  node scripts/run-annotated-video.mjs --tts-only test-artifacts/idee-flow.spec-annotated-20260425191328.mp4 test-artifacts/annotate-run-20260425191328/idee-flow-Idee-Planungsank-b4e8c-ntext-und-setzt-die-Idee-um-chromium/demo --tts-voice=de-DE-Neural2-B
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
    let forceVideo = false
    let ttsVoice = null
    const positionalArgs = []
    const unsupportedArgs = []
    for (const arg of args) {
      if (arg.startsWith('--profile=')) {
        profile = arg.slice('--profile='.length).trim()
        continue
      }
      if (arg === '--force-video') {
        forceVideo = true
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
      forceVideo,
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

function resolveDidacticText(stepEntry, channelName) {
  const didactics = stepEntry?.didactics
  if (!didactics || typeof didactics !== 'object') return null
  const candidate = didactics[channelName]
  if (!candidate || typeof candidate !== 'object') return null
  const text = typeof candidate.text === 'string' ? candidate.text.trim() : ''
  return text || null
}

function buildNarrationsFromScenarioTimeline({ scenarioRoot, timelineReport, profile, voiceOverride = null }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const steps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  if (!steps.length) {
    throw new Error('Timeline enthaelt keine Schritte.')
  }

  const stepMap = new Map(flow.map((entry) => [String(entry?.id || ''), entry]))
  const channelsConfig = profile?.channels && typeof profile.channels === 'object' ? profile.channels : {}
  const timing = profile?.timing && typeof profile.timing === 'object' ? profile.timing : {}
  const beforeChannels = Array.isArray(timing.before_step) ? timing.before_step.map(String) : []
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

  function appendSequence({ stepId, anchor, channelList, baseMs }) {
    let cursor = Math.max(0, Math.floor(baseMs))

    for (const channelNameRaw of channelList) {
      const channelName = String(channelNameRaw || '').trim()
      if (!channelName) continue

      const channelConfig = channelsConfig[channelName]
      if (!channelConfig || channelConfig.enabled !== true) {
        continue
      }

      const stepEntry = stepMap.get(stepId)
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
        voice: voiceOverride || profileVoice || undefined,
      })

      cursor = endMs + betweenChannelsMs
    }
  }

  for (const timelineStep of sortedSteps) {
    const stepId = String(timelineStep?.stepId || '').trim()
    if (!stepId) continue

    const startedAtMs = Number(timelineStep.startedAtMs)
    const endedAtMs = Number(timelineStep.endedAtMs)
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
      continue
    }

    const stepStartMs = Math.max(0, Math.floor(startedAtMs - originMs))
    const stepEndMs = Math.max(stepStartMs, Math.floor(endedAtMs - originMs))

    appendSequence({
      stepId,
      anchor: 'before',
      channelList: beforeChannels,
      baseMs: Math.max(0, stepStartMs - beforeActionMs),
    })

    appendSequence({
      stepId,
      anchor: 'after',
      channelList: afterChannels,
      baseMs: stepEndMs + afterActionMs,
    })
  }

  narrations.sort((left, right) => left.startMs - right.startMs)
  return narrations
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

async function ensureScenarioVideoTimelinePair({ scenarioPathRelative, forceVideo = false }) {
  const outputRoot = resolve('temp', 'test-results')
  if (!forceVideo) {
    const existing = await findLatestScenarioVideoTimelinePair({
      outputDir: outputRoot,
      scenarioPathRelative,
    })
    if (existing) {
      return existing
    }
  }

  console.log('Erzeuge (oder aktualisiere) Scenario-Video per Playwright...')
  const args = [
    'scripts/run-generated-testfile.mjs',
    '--mode',
    'video',
  ]
  if (forceVideo) {
    args.push('--force')
  }
  args.push(scenarioPathRelative)

  const exitCode = runCommand('node', args)
  if (exitCode !== 0) {
    throw new Error('Scenario-Video konnte nicht erzeugt werden.')
  }

  const generated = await findLatestScenarioVideoTimelinePair({
    outputDir: outputRoot,
    scenarioPathRelative,
  })
  if (!generated) {
    throw new Error('Video/Timestamp-Artefakte fuer das Szenario wurden nicht gefunden.')
  }

  return generated
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
    const shiftedStartMs = Math.max(0, Math.round(entry.startMs + cumulativeShiftMs))

    adjustedAudioFiles.push({
      ...entry,
      startMs: shiftedStartMs,
    })

    if (overflowMs > 0) {
      const pauseAtMs = Math.max(0, Math.round(entry.endMs + cumulativeShiftMs))
      pauses.push({
        atMs: pauseAtMs,
        durationMs: overflowMs,
      })
      cumulativeShiftMs += overflowMs
    }
  }

  return {
    adjustedAudioFiles,
    pauses,
    totalHoldMs: cumulativeShiftMs,
  }
}

function muxNarrationAudioIntoVideo({ inputVideo, outputVideo, audioFiles }) {
  const videoDurationSec = getMediaDurationSeconds(inputVideo)
  const audioWithDuration = audioFiles.map((entry) => ({
    ...entry,
    durationSec: getMediaDurationSeconds(entry.file),
  }))
  const { adjustedAudioFiles, pauses, totalHoldMs } = normalizeNarrationTimeline(audioWithDuration)
  const outputDurationSec = videoDurationSec + (totalHoldMs / 1000)

  if (totalHoldMs > 0) {
    console.log(`Haltebilder eingefuegt: ${pauses.length}, Gesamtwartezeit: ${(totalHoldMs / 1000).toFixed(2)}s`)
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
        let frameStart = Math.max(0, Math.min(videoDurationSec - VIDEO_HOLD_FRAME_SLICE_SEC, pauseAtSec - VIDEO_HOLD_FRAME_LEAD_SEC))
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
  const artifactsRoot = resolve('test-artifacts')
  if (!existsSync(artifactsRoot)) {
    return null
  }

  const entries = await readdir(artifactsRoot, { withFileTypes: true })
  const annotatedVideos = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${testBaseName}-annotated-`) && entry.name.endsWith('.mp4'))
    .map((entry) => entry.name)
    .filter((name) => !name.includes('-raw') && !name.includes('-tts'))
    .map((name) => {
      const match = name.match(new RegExp(`^${testBaseName}-annotated-(\\d{14})\\.mp4$`))
      if (!match) return null
      return {
        runId: match[1],
        outputVideo: join(artifactsRoot, name),
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.runId.localeCompare(left.runId))

  for (const candidate of annotatedVideos) {
    const outputDir = join(artifactsRoot, `annotate-run-${candidate.runId}`)
    const artifactPair = await findArtifactPair(outputDir)
    if (!artifactPair) continue
    const demoDir = join(artifactPair.dir, 'demo')
    if (!existsSync(demoDir)) continue

    return {
      runId: candidate.runId,
      outputDir,
      tracePath: artifactPair.tracePath,
      inputVideo: artifactPair.videoPath,
      demoDir,
      previousOutputVideo: candidate.outputVideo,
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

async function runScenarioTtsMode({ scenarioPath, profileName, outputVideo, forceVideo = false, ttsVoice = null }) {
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
    forceVideo,
  })

  const narrations = buildNarrationsFromScenarioTimeline({
    scenarioRoot,
    timelineReport: artifacts.timeline,
    profile,
    voiceOverride: ttsVoice,
  })

  if (!narrations.length) {
    throw new Error(`Keine passenden Didactic-Texte fuer Profil "${profileName}" gefunden.`)
  }

  const profileToken = sanitizeFileToken(profileName)
  const scenarioToken = sanitizeFileToken(basename(scenarioPathRelative).replace(/\.[^.]+$/, ''))
  const runId = toRunId()
  const resolvedOutputVideo = outputVideo
    ? resolve(outputVideo)
    : resolve('temp', 'final', `${scenarioToken}-${profileToken}-tts-${runId}.mp4`)

  await mkdir(dirname(resolvedOutputVideo), { recursive: true })

  const resolvedTimelinePath = join(artifacts.dir, `yaml-tts-resolved-${profileToken}.json`)
  await writeFile(resolvedTimelinePath, JSON.stringify(narrations, null, 2), 'utf8')

  const { audioFiles, engine, cacheHits, cacheMisses, cacheDir } = await synthesizeNarrations(artifacts.dir, narrations, ttsVoice)
  console.log(`TTS-Engine: ${engine}. Narrationsdateien: ${audioFiles.length}. Cache: ${cacheHits} Treffer, ${cacheMisses} neu erzeugt (${cacheDir})`)

  console.log(`Mische Profil-Voiceover in Video: ${artifacts.videoPath}`)
  muxNarrationAudioIntoVideo({
    inputVideo: artifacts.videoPath,
    outputVideo: resolvedOutputVideo,
    audioFiles,
  })

  console.log(`Aufgeloeste Narrations-Timeline: ${resolvedTimelinePath}`)
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
      forceVideo: parsed.forceVideo,
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
    const defaultOutput = resolve(
      'test-artifacts',
      `${basename(parsed.inputVideo).replace(/\.[^.]+$/, '')}-annotated-${runId}.mp4`
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
  const outputDir = resolve('test-artifacts', `annotate-run-${runId}`)
  await mkdir(outputDir, { recursive: true })
  const derivedTestTimeout = Math.max(600_000, 60_000 + (slowMo * 120))

  const defaultOutput = resolve(
    'test-artifacts',
    `${basename(testFile).replace(/\.[^.]+$/, '')}-annotated-${runId}.mp4`
  )
  const resolvedOutputVideo = outputVideo ? resolve(outputVideo) : defaultOutput
  const introlessOutputVideo = outputPathWithSuffix(resolvedOutputVideo, '-raw')

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
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
