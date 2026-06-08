#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { XMLParser } from 'fast-xml-parser'
import {
  buildCanonicalVideoCompositionModel,
  buildRemotionRenderPlan,
  buildSemanticRemotionTsx,
  buildSemanticVideoPlan,
} from './semantic-remotion.mjs'
import { getVideoScriptConfig, loadCentralConfig } from '../shared/central-config.mjs'

const OUTPUT_ROOT = resolve('output')
const OUTPUT_MANUAL_SCOPE_DIR = 'manual-runs'
const DEMO_LOGO_PATH = resolve('demo', 'img', 'lunettes.png')
const DEMO_LOGO_INTRO_DURATION_SEC = 2
const DEMO_TITLE_INTRO_DURATION_SEC = 2
const DEMO_TITLE_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const DEMO_TITLE_BOLD_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
const DEMO_INTRO_FADE_DURATION_SEC = 0.4
const DEMO_STEP_TITLE_DURATION_MS = 2000
const DEMO_STEP_TITLE_FONT_SIZE = 54
const DEMO_TTS_CACHE_DIR = join(OUTPUT_ROOT, '_tts-cache')
const DEMO_TTS_INDEX_PATH = join(DEMO_TTS_CACHE_DIR, 'index.json')
const VIDEO_HOLD_FRAME_SLICE_SEC = 0.04
const VIDEO_HOLD_FRAME_LEAD_SEC = 0.08
const DEFAULT_SLOWMO_MS = 1000

let googleTtsModulePromise

function resolveChapterFadeInDurationMs(chapterDurationMs) {
  const durationSec = Math.max(1, Number(chapterDurationMs || 0) / 1000)
  return Math.max(0, Math.round(Math.min(DEMO_INTRO_FADE_DURATION_SEC, durationSec / 3) * 1000))
}

function printUsage() {
  console.log(`Verwendung:
  node scripts/video-script-generator/run-annotated-video.mjs --scenario-tts <scenario.xml> --profile=<profil> [output.mp4] [--tts-voice=<name>]
  node scripts/video-script-generator/run-annotated-video.mjs <testfile> [output.mp4] [--slowmo=<ms>] [--tts] [--tts-voice=<name>] [weitere Playwright-Argumente]
  node scripts/video-script-generator/run-annotated-video.mjs --rerender <testfile> [output.mp4] [--tts] [--tts-voice=<name>]
  node scripts/video-script-generator/run-annotated-video.mjs --annotate-only <trace.zip> <video.webm> <demoDir> [output.mp4] [--tts] [--tts-voice=<name>]
  node scripts/video-script-generator/run-annotated-video.mjs --tts-only <annotated.mp4> <demoDir> [output-tts.mp4] [--tts-voice=<name>]

Beispiele:
  node scripts/video-script-generator/run-annotated-video.mjs --scenario-tts neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml --profile=training-basic
  node scripts/video-script-generator/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js
  node scripts/video-script-generator/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js --slowmo=1000
  node scripts/video-script-generator/run-annotated-video.mjs tests/e2e/idee-planungsanker-plaintext-flow.spec.js annotated.mp4 --project=chromium
  node scripts/video-script-generator/run-annotated-video.mjs --rerender tests/e2e/idee-flow.spec.js --tts
  node scripts/video-script-generator/run-annotated-video.mjs --annotate-only ../output/my-scenario_1_0/artifacts/trace.zip ../output/my-scenario_1_0/artifacts/video.webm ../output/my-scenario_1_0/artifacts/demo annotated.mp4 --tts
  node scripts/video-script-generator/run-annotated-video.mjs tests/e2e/idee-flow.spec.js --project=chromium --tts
  node scripts/video-script-generator/run-annotated-video.mjs --tts-only output/idee-flow-spec/manual-runs/20260425191328/final/idee-flow-spec-annotated-20260425191328.mp4 output/idee-flow-spec/manual-runs/20260425191328/artifacts/demo --tts-voice=de-DE-Neural2-B
  npm run test:e2e:annotated-video -- tests/e2e/idee-planungsanker-plaintext-flow.spec.js --project=chromium
`)
}

function buildManualRunsRoot(nameToken) {
  return join(OUTPUT_ROOT, sanitizeFileToken(nameToken), OUTPUT_MANUAL_SCOPE_DIR)
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
    let remotionPlanOnly = false
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
      if (arg === '--remotion-plan-only') {
        remotionPlanOnly = true
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
      throw new Error('Im Modus --scenario-tts wird eine Szenario-XML als Positionsargument erwartet.')
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
      remotionPlanOnly,
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

function ensureResolvedJsonForScenarioXml(scenarioAbsolutePath) {
  const scenarioName = basename(scenarioAbsolutePath, extname(scenarioAbsolutePath))
  const outDirRelative = 'temp/testfiles'
  const resolvedJsonPath = resolve(outDirRelative, `${scenarioName}.resolved.json`)

  const exitCode = runCommand('node', [
    'scripts/test-script-generator/generate-tests-from-scenario-xml.mjs',
    scenarioAbsolutePath,
    '--out-dir',
    outDirRelative,
  ])

  if (exitCode !== 0) {
    throw new Error(`Szenario konnte nicht aus XML aufgeloest werden: ${scenarioAbsolutePath}`)
  }

  if (!existsSync(resolvedJsonPath)) {
    throw new Error(`Resolved JSON fehlt nach XML-Generierung: ${resolvedJsonPath}`)
  }

  return resolvedJsonPath
}

function getResolvedXmlPathForScenarioXml(scenarioAbsolutePath) {
  const scenarioName = basename(scenarioAbsolutePath, extname(scenarioAbsolutePath))
  return resolve('temp/testfiles', `${scenarioName}.resolved.xml`)
}

function getXmlNodeTag(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null
  }

  for (const key of Object.keys(node)) {
    if (key === ':@' || key === '#text' || key === '#comment' || key === '#cdata') {
      continue
    }
    if (key.startsWith('?')) {
      continue
    }
    return key
  }

  return null
}

function findVideoScriptRangeAnchorsInResolvedXml(resolvedXmlRaw) {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })
  const parsed = parser.parse(String(resolvedXmlRaw || ''))
  const interactionTags = new Set(['Click', 'Eingabe', 'Auswahl', 'Anzeige', 'Warten', 'Oeffnen', 'SucheAuswahl'])
  let seenVideoStart = false
  let startResolvedId = null
  let stopResolvedId = null
  let lastInteractionResolvedId = null

  function visitNodes(nodes) {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        continue
      }

      const tag = getXmlNodeTag(node)
      if (!tag) {
        continue
      }

      const payload = node[tag]
      if (tag === 'VideoStart') {
        seenVideoStart = true
      }

      if (tag === 'VideoStop') {
        if (lastInteractionResolvedId && !stopResolvedId) {
          stopResolvedId = lastInteractionResolvedId
        }
        seenVideoStart = false
      }

      const attrs = node[':@'] || {}
      if (interactionTags.has(tag)) {
        const resolvedId = String(attrs['@_resolved-id'] || '').trim()
        if (resolvedId) {
          lastInteractionResolvedId = resolvedId
          if (seenVideoStart && !startResolvedId) {
            startResolvedId = resolvedId
          }
        }
      }

      const nested = Array.isArray(payload) ? payload : []
      visitNodes(nested)
    }
  }

  visitNodes(Array.isArray(parsed) ? parsed : [])
  return {
    startResolvedId,
    stopResolvedId,
  }
}

async function loadScenarioRootForTts(scenarioAbsolutePath) {
  const extension = extname(scenarioAbsolutePath).toLowerCase()
  if (extension !== '.xml') {
    throw new Error('Nur XML-Szenarien werden unterstuetzt. Bitte eine .xml-Datei uebergeben.')
  }

  const resolvedJsonPath = ensureResolvedJsonForScenarioXml(scenarioAbsolutePath)
  const resolvedXmlPath = getResolvedXmlPathForScenarioXml(scenarioAbsolutePath)
  const resolvedJsonRaw = await readFile(resolvedJsonPath, 'utf8')
  const resolvedJsonParsed = JSON.parse(resolvedJsonRaw)
  const scenarioRoot = resolvedJsonParsed.interaction || resolvedJsonParsed
  const resolvedXmlRaw = existsSync(resolvedXmlPath) ? await readFile(resolvedXmlPath, 'utf8') : ''
  const videoScriptRange = findVideoScriptRangeAnchorsInResolvedXml(resolvedXmlRaw)

  if (!scenarioRoot || typeof scenarioRoot !== 'object') {
    throw new Error('Ungueltiges aufgeloestes Szenario nach XML-Import.')
  }

  return {
    scenarioRoot,
    resolvedJsonPath,
    resolvedXmlPath,
    videoScriptRange,
  }
}

async function assertScenarioMatchesRawVideoIgnoringPresentation({
  scenarioAbsolutePath,
  scenarioPathRelative,
  artifactsDir,
}) {
  const resolvedArtifactsDir = resolve(artifactsDir)
  const outputRootResolved = resolve(OUTPUT_ROOT)

  // Artifacts may be nested below runs/<runId>/artifacts/... .
  // Resolve the nearest ancestor that contains run-meta.json.
  let scenarioOutputRoot = dirname(resolvedArtifactsDir)
  let runMetaPath = join(scenarioOutputRoot, 'run-meta.json')
  let cursor = resolvedArtifactsDir

  while (!existsSync(runMetaPath)) {
    const parent = dirname(cursor)
    if (parent === cursor) {
      break
    }
    if (!parent.startsWith(outputRootResolved)) {
      break
    }

    cursor = parent
    scenarioOutputRoot = cursor
    runMetaPath = join(scenarioOutputRoot, 'run-meta.json')
  }

  const runMeta = await readJsonIfExists(runMetaPath)

  const sourcePathFromMeta = normalizeWorkspaceRelativePath(runMeta?.scenario?.sourcePathRelative || scenarioPathRelative)
  const snapshotScenarioPath = join(scenarioOutputRoot, basename(sourcePathFromMeta))

  if (!existsSync(snapshotScenarioPath)) {
    throw new Error([
      'Kompatibilitaetspruefung fehlgeschlagen: Kein Szenario-Snapshot zum Rohvideo gefunden.',
      `Erwartet: ${snapshotScenarioPath}`,
      'Bitte Rohvideo neu erzeugen.',
    ].join(' '))
  }

  const [currentRaw, snapshotRaw] = await Promise.all([
    readFile(scenarioAbsolutePath, 'utf8'),
    readFile(snapshotScenarioPath, 'utf8'),
  ])

  const currentExtension = extname(scenarioAbsolutePath).toLowerCase()
  const snapshotExtension = extname(snapshotScenarioPath).toLowerCase()
  let currentJson
  let snapshotJson

  if (currentExtension === '.xml' && snapshotExtension === '.xml') {
    currentJson = JSON.stringify(currentRaw.replace(/\s+/g, ' ').trim())
    snapshotJson = JSON.stringify(snapshotRaw.replace(/\s+/g, ' ').trim())
  } else {
    const currentParsed = JSON.parse(currentRaw)
    const snapshotParsed = JSON.parse(snapshotRaw)
    const currentComparable = toCanonicalComparable(stripPresentationDeep(currentParsed?.interaction || currentParsed || {}))
    const snapshotComparable = toCanonicalComparable(stripPresentationDeep(snapshotParsed?.interaction || snapshotParsed || {}))
    currentJson = JSON.stringify(currentComparable)
    snapshotJson = JSON.stringify(snapshotComparable)
  }

  if (currentJson !== snapshotJson) {
    throw new Error([
      'Das aktuelle Szenario passt nicht mehr zum vorhandenen Rohvideo (Vergleich ignoriert presentation).',
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
    return {
      enabled: true,
      beforeMs: 800,
      afterMs: 100,
      fadeMs: 50,
    }
  }

  const enabled = clickConfig.enabled !== false
  const beforeMs = Math.max(0, Number(clickConfig.before_ms ?? 800) || 800)
  const afterMs = Math.max(0, Number(clickConfig.after_ms ?? 100) || 100)
  const fadeMs = Math.max(0, Number(clickConfig.fade_ms ?? 50) || 50)

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

function synthAnonChapterId(idPrefix, index) {
  return `__anon-chapter-${idPrefix ? `${idPrefix}:` : ''}${index}`
}

function flattenFlowSteps(flowEntries, out = [], idPrefix = '') {
  for (let index = 0; index < (flowEntries || []).length; index += 1) {
    const step = flowEntries[index]
    if (!step || typeof step !== 'object') {
      continue
    }

    const stepId = String(step.id || '').trim()
    if (!stepId) {
      if (step.chapter) {
        // Chapter-only marker without id: include with synthetic id for position tracking
        out.push({
          id: synthAnonChapterId(idPrefix, index),
          step,
          isIncludeContainer: false,
          isSyntheticId: true,
        })
      }
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

function findFlowStepIdByResolvedId(flowEntries, resolvedId) {
  const normalizedResolvedId = String(resolvedId || '').trim()
  if (!normalizedResolvedId) {
    return null
  }

  const flattened = flattenFlowSteps(flowEntries)
  const match = flattened.find((entry) => String(entry?.step?.resolvedId || '').trim() === normalizedResolvedId)
  return String(match?.id || '').trim() || null
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

function collectPresentationVideoDirectivesFromFlow(flowEntries, out = [], idPrefix = '') {
  for (let index = 0; index < (flowEntries || []).length; index += 1) {
    const step = flowEntries[index]
    if (!step || typeof step !== 'object') {
      continue
    }

    const stepId = String(step.id || '').trim()
    const effectiveStepId = stepId || (step.chapter ? synthAnonChapterId(idPrefix, index) : '')

    const presentationVideo = step?.presentation?.video
    if (presentationVideo && typeof presentationVideo === 'object') {
      const start = presentationVideo.start != null ? String(presentationVideo.start).trim().toLowerCase() : null
      const stop = presentationVideo.stop != null ? String(presentationVideo.stop).trim().toLowerCase() : null
      if (start || stop) {
        out.push({
          stepId: effectiveStepId,
          start,
          stop,
        })
      }
    }

    if (Array.isArray(step.flow) && step.flow.length > 0) {
      const childPrefix = stepId ? (idPrefix ? `${idPrefix}-${stepId}` : stepId) : idPrefix
      collectPresentationVideoDirectivesFromFlow(step.flow, out, childPrefix)
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

function resolveNeighborWindowForAnonStep(stepId, flattenedFlowStepEntries, sortedTimelineSteps) {
  const entryIndex = flattenedFlowStepEntries.findIndex((e) => e.id === stepId)
  if (entryIndex < 0) return null

  for (let i = entryIndex + 1; i < flattenedFlowStepEntries.length; i += 1) {
    if (flattenedFlowStepEntries[i].isSyntheticId) continue
    const w = resolvePresentationStepWindowMs(flattenedFlowStepEntries[i].id, sortedTimelineSteps)
    if (w) return w
  }

  for (let i = entryIndex - 1; i >= 0; i -= 1) {
    if (flattenedFlowStepEntries[i].isSyntheticId) continue
    const w = resolvePresentationStepWindowMs(flattenedFlowStepEntries[i].id, sortedTimelineSteps)
    if (w) return w
  }

  return null
}

function resolveScenarioPresentationVideoRangeFromTimeline({ scenarioRoot, timelineReport, videoScriptRange = null }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const timelineSteps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  if (!flow.length || !timelineSteps.length) {
    return null
  }

  const directives = collectPresentationVideoDirectivesFromFlow(flow)
  const videoStartStepId = findFlowStepIdByResolvedId(flow, videoScriptRange?.startResolvedId)
  const videoStopStepId = findFlowStepIdByResolvedId(flow, videoScriptRange?.stopResolvedId)
  if (!directives.length && !videoStartStepId && !videoStopStepId) {
    return null
  }

  const flattenedFlowStepEntries = flattenFlowSteps(flow)
  const sortedTimelineSteps = [...timelineSteps].sort((left, right) => Number(left.startedAtMs || 0) - Number(right.startedAtMs || 0))
  const originMs = Number(sortedTimelineSteps[0]?.startedAtMs || 0)
  if (!Number.isFinite(originMs)) {
    return null
  }

  let startAbsMs = null
  let endAbsMs = null
  let startDirectiveStepId = null

  if (videoStartStepId || videoScriptRange?.startResolvedId) {
    const videoStartWindow =
      resolvePresentationStepWindowMs(videoStartStepId, sortedTimelineSteps)
      || resolvePresentationStepWindowMs(videoScriptRange?.startResolvedId, sortedTimelineSteps)
    if (videoStartWindow) {
      startAbsMs = videoStartWindow.startedAtMs
      startDirectiveStepId = videoStartStepId
    }
  }

  if (videoStopStepId || videoScriptRange?.stopResolvedId) {
    const videoStopWindow =
      resolvePresentationStepWindowMs(videoStopStepId, sortedTimelineSteps)
      || resolvePresentationStepWindowMs(videoScriptRange?.stopResolvedId, sortedTimelineSteps)
    if (videoStopWindow) {
      endAbsMs = videoStopWindow.endedAtMs
    }
  }

  for (const directive of directives) {
    let window = resolvePresentationStepWindowMs(directive.stepId, sortedTimelineSteps)
    if (!window) {
      window = resolveNeighborWindowForAnonStep(directive.stepId, flattenedFlowStepEntries, sortedTimelineSteps)
    }
    if (!window) {
      console.warn(`[scenario-tts] presentation.video for step "${directive.stepId}" ignored: step not found in timeline and no neighbor found.`)
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
    startStepId: videoStartStepId,
    stopStepId: videoStopStepId,
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

function buildChapterNarrationsFromScenario({ scenarioRoot, chapterTitles, profile, voiceOverride = null }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const flattenedFlowStepEntries = flattenFlowSteps(flow)
  const stepById = new Map(flattenedFlowStepEntries.map((entry) => [String(entry?.id || '').trim(), entry?.step || null]))

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

  const narrations = []

  function appendSequence({ stepId, scenarioStepId, stepEntry, anchor, channelList, baseMs, maxEndMs = null, explanationDelayMs = 0, chapterStartMs = null }) {
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

      const effectiveStartMs = (anchor === 'during' && channelName === 'explanation')
        ? cursor + Math.max(0, Math.floor(explanationDelayMs || 0))
        : cursor
      const startMs = Math.max(0, Math.floor(effectiveStartMs))
      const unclampedEndMs = Math.max(startMs + 1, Math.floor(cursor + minWindowMs))
      let endMs = Number.isFinite(maxEndMs)
        ? Math.max(startMs + 1, Math.min(unclampedEndMs, Math.floor(maxEndMs)))
        : unclampedEndMs

      // For chapter overlays, keep during-narration inside the full chapter window
      // so muxing does not create artificial overflow holds.
      if (anchor === 'during' && Number.isFinite(maxEndMs)) {
        endMs = Math.max(startMs + 1, Math.floor(maxEndMs))
      }

      narrations.push({
        id: `${stepId}-chapter-${anchor}-${channelName}`,
        startMs,
        endMs,
        text: spokenText,
        sourceTimelineStepId: stepId,
        sourceScenarioStepId: scenarioStepId,
        sourceAnchor: `chapter-${anchor}`,
        sourceKind: 'chapter',
        sourceChannel: channelName,
        sourceChapterStartMs: Number.isFinite(chapterStartMs) ? Math.max(0, chapterStartMs) : undefined,
        voice: voiceOverride || profileVoice || undefined,
      })

      cursor = endMs + betweenChannelsMs
    }
  }

  const sortedChapterTitles = [...(chapterTitles || [])]
    .sort((left, right) => Number(left?.atMs || 0) - Number(right?.atMs || 0))

  let chapterTimelineCursorMs = 0
  for (const chapterTitle of sortedChapterTitles) {
    const scenarioStepId = String(chapterTitle?.sourceScenarioStepId || '').trim()
    if (!scenarioStepId) {
      continue
    }

    const stepEntry = stepById.get(scenarioStepId)
    if (!stepEntry || typeof stepEntry !== 'object') {
      continue
    }

    const chapterAnchorMs = Math.max(0, Math.floor(Number(chapterTitle?.atMs) || 0))
    const chapterDurationMs = Math.max(1, Math.floor(Number(chapterTitle?.durationMs) || DEMO_STEP_TITLE_DURATION_MS))
    const chapterStartMs = Math.max(chapterAnchorMs, chapterTimelineCursorMs)
    const chapterEndMs = chapterStartMs + chapterDurationMs
    const chapterFadeInMs = resolveChapterFadeInDurationMs(chapterDurationMs)
    const stepId = String(chapterTitle?.id || scenarioStepId).trim() || scenarioStepId
    chapterTimelineCursorMs = chapterEndMs

    appendSequence({
      stepId,
      scenarioStepId,
      stepEntry,
      anchor: 'before',
      channelList: beforeChannels,
      baseMs: Math.max(0, chapterStartMs - beforeActionMs),
      chapterStartMs,
    })

    appendSequence({
      stepId,
      scenarioStepId,
      stepEntry,
      anchor: 'during',
      channelList: duringChannels,
      baseMs: chapterStartMs,
      maxEndMs: chapterEndMs,
      explanationDelayMs: chapterFadeInMs,
      chapterStartMs,
    })

    appendSequence({
      stepId,
      scenarioStepId,
      stepEntry,
      anchor: 'after',
      channelList: afterChannels,
      baseMs: chapterEndMs + afterActionMs,
      chapterStartMs,
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

  const hasExplicitDuration = chapter.duration_ms != null || chapter.durationMs != null
  const rawDuration = Number(chapter.duration_ms ?? chapter.durationMs)
  const durationMs = Math.max(
    1000,
    Number.isFinite(rawDuration) ? Math.floor(rawDuration) : DEMO_STEP_TITLE_DURATION_MS,
  )
  const rawFontSize = Number(chapter.font_size ?? chapter.fontSize)
  const fontSize = Math.max(
    1,
    Number.isFinite(rawFontSize) ? Math.floor(rawFontSize) : DEMO_STEP_TITLE_FONT_SIZE,
  )
  const rawTextYStart = Number(chapter.text_y_start ?? chapter.textYStart)
  const textYStart = Number.isFinite(rawTextYStart)
    ? Math.max(0, Math.floor(rawTextYStart))
    : null
  const rawLineSpacing = Number(chapter.line_spacing ?? chapter.lineSpacing)
  const lineSpacing = Number.isFinite(rawLineSpacing)
    ? Math.max(0, Math.floor(rawLineSpacing))
    : null

  return {
    text,
    durationMs,
    fontSize,
    textYStart,
    lineSpacing,
    hasExplicitDuration,
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
      fontSize: chapterCard.fontSize,
      textYStart: chapterCard.textYStart,
      lineSpacing: chapterCard.lineSpacing,
      hasExplicitDuration: chapterCard.hasExplicitDuration,
      sourceTimelineStepId: chapterStepId,
      sourceScenarioStepId: chapterStepId,
    })
  }

  chapterTitles.sort((left, right) => left.atMs - right.atMs)
  return chapterTitles
}

async function collectArtifactDirs(rootDir) {
  if (!existsSync(rootDir)) return []

  const entries = await readdir(rootDir, { withFileTypes: true })
  const dirs = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const fullPath = join(rootDir, entry.name)
    dirs.push(fullPath)
    dirs.push(...await collectArtifactDirs(fullPath))
  }

  return dirs
}

async function findLatestScenarioVideoTimelinePair({ outputDir, scenarioPathRelative }) {
  if (!existsSync(outputDir)) return null
  const normalizedScenarioPath = normalizeWorkspaceRelativePath(scenarioPathRelative)

  const dirs = [outputDir, ...await collectArtifactDirs(outputDir)]
  const candidates = []

  for (const dir of dirs) {
    const videoPath = join(dir, 'video.webm')
    const timelinePath = join(dir, 'scenario-step-timeline.json')
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

function applyNarrationTimingToAudioFiles(audioFiles, narrations) {
  const timingById = new Map(
    (Array.isArray(narrations) ? narrations : []).map((entry) => [String(entry?.id || ''), entry])
  )

  return (Array.isArray(audioFiles) ? audioFiles : []).map((entry) => {
    const timing = timingById.get(String(entry?.id || ''))
    if (!timing) {
      return entry
    }

    return {
      ...entry,
      startMs: Number(timing.startMs),
      endMs: Number(timing.endMs),
      sourceAnchor: timing.sourceAnchor,
      sourceScenarioStepId: timing.sourceScenarioStepId,
      sourceTimelineStepId: timing.sourceTimelineStepId,
      sourceKind: timing.sourceKind,
      sourceChannel: timing.sourceChannel,
    }
  })
}

function resolveChapterDurationsFromSynthesizedAudio({ chapterTitles, chapterNarrations, audioFiles }) {
  const chapterByScenarioStepId = new Map(
    (Array.isArray(chapterTitles) ? chapterTitles : []).map((entry) => [String(entry?.sourceScenarioStepId || '').trim(), entry])
  )
  const chapterNarrationById = new Map(
    (Array.isArray(chapterNarrations) ? chapterNarrations : []).map((entry) => [String(entry?.id || ''), entry])
  )

  const chapterExplanationDurations = new Map()
  const chapterFallbackDurations = new Map()

  for (const audioFile of Array.isArray(audioFiles) ? audioFiles : []) {
    const narrationId = String(audioFile?.id || '')
    const narration = chapterNarrationById.get(narrationId)
    if (!narration) {
      continue
    }

    const scenarioStepId = String(narration?.sourceScenarioStepId || '').trim()
    if (!scenarioStepId || !chapterByScenarioStepId.has(scenarioStepId)) {
      continue
    }

    const audioDurationMs = Math.max(1, Math.round(getMediaDurationSeconds(audioFile.file) * 1000))
    const chapterStartFromNarration = Number(narration?.sourceChapterStartMs)
    const chapterStartMs = Number.isFinite(chapterStartFromNarration)
      ? Math.max(0, chapterStartFromNarration)
      : Math.max(0, Number(chapterByScenarioStepId.get(scenarioStepId)?.atMs) || 0)
    const narrationStartMs = Math.max(chapterStartMs, Number(narration?.startMs) || chapterStartMs)
    const relativeEndMs = Math.max(1, Math.round((narrationStartMs - chapterStartMs) + audioDurationMs))

    const existingFallback = Math.max(0, Number(chapterFallbackDurations.get(scenarioStepId) || 0))
    chapterFallbackDurations.set(scenarioStepId, Math.max(existingFallback, relativeEndMs))

    if (String(narration?.sourceChannel || '').trim() === 'explanation') {
      const existingExplanation = Math.max(0, Number(chapterExplanationDurations.get(scenarioStepId) || 0))
      chapterExplanationDurations.set(scenarioStepId, Math.max(existingExplanation, relativeEndMs))
    }
  }

  return (Array.isArray(chapterTitles) ? chapterTitles : []).map((chapterTitle) => {
    const scenarioStepId = String(chapterTitle?.sourceScenarioStepId || '').trim()
    if (!scenarioStepId) {
      return chapterTitle
    }

    if (chapterTitle.hasExplicitDuration) {
      return chapterTitle
    }

    const autoDurationMs = Math.max(
      0,
      Number(chapterExplanationDurations.get(scenarioStepId) || chapterFallbackDurations.get(scenarioStepId) || 0),
    )
    if (!Number.isFinite(autoDurationMs) || autoDurationMs <= 0) {
      return chapterTitle
    }

    return {
      ...chapterTitle,
      durationMs: Math.max(1, Math.floor(autoDurationMs)),
    }
  })
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
    const fontSize = Math.max(
      1,
      Number(entry.fontSize ?? entry.font_size) || DEMO_STEP_TITLE_FONT_SIZE,
    )
    const rawTextYStart = Number(entry.textYStart ?? entry.text_y_start)
    const textYStart = Number.isFinite(rawTextYStart)
      ? Math.max(0, Math.floor(rawTextYStart))
      : null
    const rawLineSpacing = Number(entry.lineSpacing ?? entry.line_spacing)
    const lineSpacing = Number.isFinite(rawLineSpacing)
      ? Math.max(0, Math.floor(rawLineSpacing))
      : null
    const clipRelativeAtMs = atMs - clip.startMs
    if (clip.endMs !== null && atMs >= clip.endMs) return null
    return {
      id: String(entry.id),
      title,
      atMs: clipRelativeAtMs,
      durationMs,
      fontSize,
      textYStart,
      lineSpacing,
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

function getVideoFps(filePath) {
  const output = runCommandWithOutput('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    filePath,
  ]).trim()

  if (!output || output === '0/0') {
    return 30
  }

  const [numRaw, denRaw] = output.split('/')
  const num = Number.parseFloat(numRaw)
  const den = Number.parseFloat(denRaw)
  const fps = den > 0 ? (num / den) : num
  if (!Number.isFinite(fps) || fps <= 0) {
    return 30
  }
  return fps
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

function normalizeChapterMarkdownLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed) {
    return ''
  }

  let text = trimmed
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '• ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')

  return text.trimEnd()
}

function chapterTextToOverlayLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => normalizeChapterMarkdownLine(line))
}

function parseChapterMarkdownSpans(line) {
  const normalized = String(line || '')
  const spans = []
  let cursor = 0

  while (cursor < normalized.length) {
    const start = normalized.indexOf('**', cursor)
    if (start < 0) {
      const tail = normalized.slice(cursor)
      if (tail) {
        spans.push({ text: tail, bold: false })
      }
      break
    }

    const before = normalized.slice(cursor, start)
    if (before) {
      spans.push({ text: before, bold: false })
    }

    const end = normalized.indexOf('**', start + 2)
    if (end < 0) {
      const remainder = normalized.slice(start)
      if (remainder) {
        spans.push({ text: remainder, bold: false })
      }
      break
    }

    const boldText = normalized.slice(start + 2, end)
    if (boldText) {
      spans.push({ text: boldText, bold: true })
    }

    cursor = end + 2
  }

  return spans
}

function estimateChapterTextWidth(text, fontSize, isBold = false) {
  const normalized = String(text || '')
  const perChar = fontSize * (isBold ? 0.62 : 0.56)
  return Math.max(fontSize * 0.25, normalized.length * perChar)
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
    const fontSize = Math.max(1, Number(stepTitle.fontSize) || DEMO_STEP_TITLE_FONT_SIZE)
    const customTextYStart = Number(stepTitle.textYStart ?? stepTitle.text_y_start)
    const hasCustomTextYStart = Number.isFinite(customTextYStart)
    const textYStart = hasCustomTextYStart ? Math.max(0, Math.floor(customTextYStart)) : 0
    const customLineSpacing = Number(stepTitle.lineSpacing ?? stepTitle.line_spacing)
    const lineSpacing = Number.isFinite(customLineSpacing) ? Math.max(0, Math.floor(customLineSpacing)) : 8
    const titleLines = chapterTextToOverlayLines(stepTitle.title)
    const hasNonEmptyLine = titleLines.some((line) => String(line || '').trim().length > 0)
    const renderLines = hasNonEmptyLine ? titleLines : [String(stepTitle.title || '').trim() || ' ']
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
    const titleDrawtextFilters = []
    for (let lineIndex = 0; lineIndex < renderLines.length; lineIndex += 1) {
      const line = renderLines[lineIndex]
      const lineSpans = parseChapterMarkdownSpans(line)
      const yExpr = hasCustomTextYStart
        ? `${textYStart}+${lineIndex}*(${fontSize + lineSpacing})`
        : `(h-text_h)/2+(${(lineIndex - ((renderLines.length - 1) / 2)).toFixed(3)})*(${fontSize + lineSpacing})`

      if (lineSpans.length === 0) {
        titleDrawtextFilters.push(
          `drawtext=text='${escapeFfmpegDrawtext(' ')}':fontfile=${DEMO_TITLE_FONT}:fontsize=${fontSize}:fontcolor=black:x=(w-text_w)/2:y=${yExpr}`
        )
        continue
      }

      const lineWidth = lineSpans.reduce(
        (sum, span) => sum + estimateChapterTextWidth(span.text, fontSize, span.bold),
        0,
      )
      let xOffset = 0
      for (const span of lineSpans) {
        const spanFont = span.bold ? DEMO_TITLE_BOLD_FONT : DEMO_TITLE_FONT
        const spanWidth = estimateChapterTextWidth(span.text, fontSize, span.bold)
        const xExpr = `(w-${lineWidth.toFixed(3)})/2+${xOffset.toFixed(3)}`
        titleDrawtextFilters.push(
          `drawtext=text='${escapeFfmpegDrawtext(span.text)}':fontfile=${spanFont}:fontsize=${fontSize}:fontcolor=black:x=${xExpr}:y=${yExpr}`
        )
        xOffset += spanWidth
      }
    }

    const titleDrawtextChain = titleDrawtextFilters.join(',')

    filterParts.push(
      `[0:v]trim=start=${frameSrc.toFixed(3)}:end=${frameEnd.toFixed(3)},` +
      `setpts=PTS-STARTPTS,` +
      `tpad=stop_mode=clone:stop_duration=${durationSec.toFixed(3)},` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill,` +
      `${titleDrawtextChain},` +
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

function insertNarrationPauseHoldsIntoVideo({ inputVideo, outputVideo, pauses, clickHolds = [] }) {
  const videoDurationSec = getMediaDurationSeconds(inputVideo)
  const clickHoldRangesSec = toSortedClickHoldRangesSec(clickHolds)
  const sortedPauses = [...pauses].sort((left, right) => left.atMs - right.atMs)
  const filterParts = []
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

  runCommand('ffmpeg', [
    '-y',
    '-i', inputVideo,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    outputVideo,
  ])
}

function readJsonSyncIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function resolveArchitectureContextFromVideo(inputVideo) {
  const annotateMeta = readJsonSyncIfExists(`${inputVideo}.annotate-meta.json`)
  if (!annotateMeta || typeof annotateMeta !== 'object') {
    return null
  }

  const remotionPlanPath = String(annotateMeta.remotionPlanPath || '').trim()
  const remotionPlan = remotionPlanPath ? readJsonSyncIfExists(remotionPlanPath) : null
  return {
    annotateMeta,
    remotionPlan,
    remotionPlanPath: remotionPlanPath || null,
  }
}

function writeSemanticRemotionArtifacts({ inputVideo, outputVideo, adjustedAudioFiles, semanticContext, render = true }) {
  const renderPlanPath = `${outputVideo}.remotion-render-plan.json`
  const canonicalModelPath = `${outputVideo}.composition-model.json`
  const semanticVideoPlanPath = `${outputVideo}.semantic-video-plan.json`
  const renderScriptTsxPath = `${outputVideo}.semantic.tsx`
  const widthHeight = getVideoDimensions(inputVideo)
  const fps = getVideoFps(inputVideo)
  const semanticRuntimePath = resolve('scripts/video-script-generator/runtime/semantic-runtime.tsx')

  const canonicalModel = buildCanonicalVideoCompositionModel({
    scenarioRoot: semanticContext?.scenarioRoot || null,
    timelineReport: semanticContext?.timelineReport || null,
    chapterCards: semanticContext?.chapterCards || [],
    adjustedAudioFiles,
    clickMarkers: semanticContext?.clickMarkers || [],
    inputVideo,
    width: widthHeight.width,
    height: widthHeight.height,
    fps,
    clickIndicator: semanticContext?.clickIndicator || {
      beforeMs: 800,
      highlightDurationMs: 300,
      afterMs: 100,
      fadeMs: 50,
    },
  })

  writeFileSync(canonicalModelPath, JSON.stringify(canonicalModel, null, 2), 'utf8')

  const semanticVideoPlan = buildSemanticVideoPlan({
    scenarioRoot: semanticContext?.scenarioRoot || null,
    timelineReport: semanticContext?.timelineReport || null,
    presentationRange: semanticContext?.presentationRange || null,
    chapterCards: semanticContext?.chapterCards || [],
    clickMarkers: semanticContext?.clickMarkers || [],
    clickIndicator: semanticContext?.clickIndicator || null,
    stepSegments: semanticContext?.stepSegments || [],
    adjustedAudioFiles,
    inputVideo,
    outputVideo,
    width: widthHeight.width,
    height: widthHeight.height,
    fps,
  })
  const renderPlan = buildRemotionRenderPlan({
    semanticPlan: semanticVideoPlan,
    outputVideo,
    adjustedAudioFiles,
  })
  const renderScriptTsx = buildSemanticRemotionTsx({
    semanticPlan: semanticVideoPlan,
    outputFilePath: renderScriptTsxPath,
    runtimeFilePath: semanticRuntimePath,
  })

  writeFileSync(renderPlanPath, JSON.stringify(renderPlan, null, 2), 'utf8')
  writeFileSync(semanticVideoPlanPath, JSON.stringify(semanticVideoPlan, null, 2), 'utf8')
  writeFileSync(renderScriptTsxPath, renderScriptTsx, 'utf8')

  if (render) {
    const exitCode = runCommand('node', [
      'scripts/video-script-generator/remotion-mux-video-tts.mjs',
      `--plan=${renderPlanPath}`,
      `--tsx=${renderScriptTsxPath}`,
    ])
    if (exitCode !== 0) {
      throw new Error(`Remotion-Mux fehlgeschlagen (Exit-Code ${exitCode}).`)
    }
  }

  return {
    renderPlanPath,
    semanticVideoPlanPath: canonicalModelPath,
    renderScriptTsxPath,
  }
}

function muxNarrationAudioIntoVideo({ inputVideo, outputVideo, audioFiles, semanticContext = null, render = true }) {
  const videoDurationSec = getMediaDurationSeconds(inputVideo)
  const audioWithDuration = audioFiles.map((entry) => ({
    ...entry,
    durationSec: getMediaDurationSeconds(entry.file),
  }))
  const { adjustedAudioFiles, pauses, totalHoldMs } = normalizeNarrationTimeline(audioWithDuration)
  const outputDurationSec = videoDurationSec + (totalHoldMs / 1000)
  const ttsDebugAll = ['1', 'true', 'yes', 'on'].includes(String(process.env.SCENARIO_TTS_DEBUG || '').trim().toLowerCase())

  if (totalHoldMs > 0) {
    console.log(`Wartezeiten geplant: ${pauses.length}, Gesamtwartezeit: ${(totalHoldMs / 1000).toFixed(2)}s`)
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

  let remotionRenderPlanPath = null
  let remotionSemanticPlanPath = null
  let remotionRenderScriptTsxPath = null

  const remotionArtifacts = writeSemanticRemotionArtifacts({
    inputVideo,
    outputVideo,
    adjustedAudioFiles,
    semanticContext,
    render,
  })
  remotionRenderPlanPath = remotionArtifacts.renderPlanPath
  remotionSemanticPlanPath = remotionArtifacts.semanticVideoPlanPath
  remotionRenderScriptTsxPath = remotionArtifacts.renderScriptTsxPath

  return {
    adjustedAudioFiles,
    pauses,
    totalHoldMs,
    outputDurationSec,
    remotionRenderPlanPath,
    remotionSemanticPlanPath,
    remotionRenderScriptTsxPath,
  }
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
  const testRunsRoot = buildManualRunsRoot(testToken)
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
    'scripts/video-script-generator/annotate-video-from-trace.mjs',
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

function buildScenarioTtsDiagnosticsLog({
  scenarioPath,
  profileName,
  sourceVideo,
  outputVideo,
  totalHoldMs = 0,
  pauses = [],
  resolvedNarrations = [],
  adjustedById = new Map(),
}) {
  const lines = []
  lines.push(`# scenario-tts diagnostics`)
  lines.push(`scenario=${String(scenarioPath || '')}`)
  lines.push(`profile=${String(profileName || '')}`)
  lines.push(`sourceVideo=${String(sourceVideo || '')}`)
  lines.push(`outputVideo=${String(outputVideo || '')}`)
  lines.push(`totalHoldMs=${Math.max(0, Math.floor(Number(totalHoldMs) || 0))}`)
  lines.push(`pauseCount=${Array.isArray(pauses) ? pauses.length : 0}`)
  lines.push('')

  if (Array.isArray(pauses) && pauses.length > 0) {
    lines.push('## pauses')
    pauses.forEach((pause, index) => {
      const atMs = Math.max(0, Math.floor(Number(pause?.atMs || 0)))
      const durationMs = Math.max(0, Math.floor(Number(pause?.durationMs || 0)))
      lines.push(`${index + 1}. atMs=${atMs} durationMs=${durationMs}`)
    })
    lines.push('')
  }

  lines.push('## narrations')
  const entries = Array.isArray(resolvedNarrations) ? resolvedNarrations : []
  if (entries.length === 0) {
    lines.push('(none)')
    return `${lines.join('\n')}\n`
  }

  const sorted = [...entries].sort((left, right) => {
    const startDiff = Number(left?.clipVideoStartMs || 0) - Number(right?.clipVideoStartMs || 0)
    if (startDiff !== 0) return startDiff
    return Number(left?.clipVideoEndMs || 0) - Number(right?.clipVideoEndMs || 0)
  })

  sorted.forEach((entry, index) => {
    const id = String(entry?.id || '')
    const adjusted = adjustedById && typeof adjustedById.get === 'function'
      ? adjustedById.get(id)
      : null
    const clipStart = Math.max(0, Math.floor(Number(entry?.clipVideoStartMs || 0)))
    const clipEnd = Math.max(clipStart, Math.floor(Number(entry?.clipVideoEndMs || clipStart)))
    const finalStart = Math.max(0, Math.floor(Number(entry?.finalInsertedStartMs || clipStart)))
    const finalEnd = Math.max(finalStart, Math.floor(Number(entry?.finalInsertedEndMs || clipEnd)))
    const overflowMs = adjusted ? Math.max(0, Math.floor(Number(adjusted?.overflowMs || 0))) : 0
    const channel = String(entry?.sourceChannel || '')
    const kind = String(entry?.sourceKind || '')

    lines.push(`${index + 1}. id=${id} channel=${channel} kind=${kind} clip=${clipStart}-${clipEnd} final=${finalStart}-${finalEnd} overflow=${overflowMs}`)
  })

  return `${lines.join('\n')}\n`
}

async function runScenarioTtsMode({ scenarioPath, profileName, outputVideo, ttsVoice = null, remotionPlanOnly = false }) {
  const central = loadCentralConfig(process.cwd())
  const videoScriptConfig = getVideoScriptConfig(central.config)
  const scenarioAbsolutePath = resolve(scenarioPath)
  if (!existsSync(scenarioAbsolutePath)) {
    throw new Error(`Szenario-Datei nicht gefunden: ${scenarioPath}`)
  }

  if (extname(scenarioAbsolutePath).toLowerCase() !== '.xml') {
    throw new Error('Im Modus --scenario-tts werden nur XML-Szenarien unterstuetzt.')
  }

  const scenarioPathRelative = normalizeWorkspaceRelativePath(scenarioPath)
  const profile = resolveScenarioTtsProfile(videoScriptConfig, profileName)

  const { scenarioRoot, videoScriptRange } = await loadScenarioRootForTts(scenarioAbsolutePath)

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
    videoScriptRange,
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

  let sourceVideoForTts = artifacts.videoPath

  if (presentationRange) {
    const clippedSourceVideo = join(ttsOutputDir, `${scenarioToken}-${profileToken}-clip-${runId}.mp4`)
    cutVideoToRange({
      inputVideo: artifacts.videoPath,
      outputVideo: clippedSourceVideo,
      startMs: Math.max(0, Number(presentationRange.startMs) || 0),
      endMs: presentationRange.endMs == null ? null : Math.max(0, Number(presentationRange.endMs) || 0),
    })
    sourceVideoForTts = clippedSourceVideo
  }
  let clickAnnotateMeta = { clickHolds: [] }
  let visualRemotionPlan = null

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
      'scripts/video-script-generator/annotate-video-from-trace.mjs',
      tracePath,
      artifacts.videoPath,
      clickAnnotatedVideo,
      `--scenario-xml=${scenarioAbsolutePath}`,
      '--skip-remotion-script',
    ]

    // Trace pass is data-only here: all visual cutting/overlay is handled by Remotion.
    annotateArgs.push('--plan-only')

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

    clickAnnotateMeta = await readAnnotateMetaIfExists(clickAnnotatedVideo)
    const annotateMetaRaw = await readJsonIfExists(getAnnotateMetaPath(clickAnnotatedVideo))
    let remotionPlanPath = String(annotateMetaRaw?.remotionPlanPath || '').trim()
    if (!remotionPlanPath) {
      const fallbackRemotionPlanPath = `${clickAnnotatedVideo}.remotion-plan.json`
      if (existsSync(fallbackRemotionPlanPath)) {
        remotionPlanPath = fallbackRemotionPlanPath
      }
    }
    if (remotionPlanPath) {
      visualRemotionPlan = await readJsonIfExists(remotionPlanPath)
    }
  }

  if (presentationRange && !remotionPlanOnly) {
    const presentationMetaPath = join(ttsOutputDir, `scenario-presentation-range-${profileToken}-${runId}.json`)
    await writeFile(presentationMetaPath, JSON.stringify({
      sourceVideo: artifacts.videoPath,
      clippedVideo: sourceVideoForTts,
      startMs: presentationRange.startMs,
      endMs: presentationRange.endMs,
      directives: presentationRange.directives,
    }, null, 2), 'utf8')
  }

  let clickHolds = Array.isArray(clickAnnotateMeta?.clickHolds) ? clickAnnotateMeta.clickHolds : []
  if (clickHolds.length === 0 && Array.isArray(visualRemotionPlan?.timeline?.clickMarkers) && visualRemotionPlan.timeline.clickMarkers.length > 0) {
    const durationMs = Math.max(0, Math.floor((Number(clickIndicatorConfig?.beforeMs || 0) + Number(clickIndicatorConfig?.afterMs || 0))))
    if (durationMs > 0) {
      clickHolds = visualRemotionPlan.timeline.clickMarkers.map((marker) => ({
        atMs: Math.max(0, Math.round(Number(marker?.at || 0) * 1000)),
        durationMs,
      }))
    }
  }
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

  const chapterTitlesForNarration = rawChapterTitles.map((entry) => ({
    ...entry,
    atMs: applyClickHoldShift(entry.atMs, clickHolds),
  }))

  const chapterTitlesForOverlays = rawChapterTitles.map((entry) => ({
    ...entry,
    atMs: Math.max(0, Number(entry.atMs) || 0),
  }))

  let chapterNarrations = buildChapterNarrationsFromScenario({
    scenarioRoot,
    chapterTitles: chapterTitlesForNarration,
    profile,
    voiceOverride: ttsVoice,
  })
  if (chapterNarrations.length > 0) {
    effectiveNarrations = [...effectiveNarrations, ...chapterNarrations]
    effectiveNarrations.sort((left, right) => Number(left?.startMs || 0) - Number(right?.startMs || 0))
  }

  let synthesizedNarrations = null
  async function ensureSynthesizedNarrations() {
    if (synthesizedNarrations || !effectiveNarrations.length) {
      return synthesizedNarrations
    }

    synthesizedNarrations = await synthesizeNarrations(artifacts.dir, effectiveNarrations, ttsVoice)
    console.log(`TTS-Engine: ${synthesizedNarrations.engine}. Narrationsdateien: ${synthesizedNarrations.audioFiles.length}. Cache: ${synthesizedNarrations.cacheHits} Treffer, ${synthesizedNarrations.cacheMisses} neu erzeugt (${synthesizedNarrations.cacheDir})`)
    return synthesizedNarrations
  }

  let resolvedChapterCards = chapterTitlesForOverlays
  const hasAutoDurationChapter = chapterTitlesForNarration.some((entry) => !entry.hasExplicitDuration)
  if (hasAutoDurationChapter && chapterNarrations.length > 0 && effectiveNarrations.length > 0) {
    const synthesized = await ensureSynthesizedNarrations()
    const resolvedChapterTitlesForNarration = resolveChapterDurationsFromSynthesizedAudio({
      chapterTitles: chapterTitlesForNarration,
      chapterNarrations,
      audioFiles: synthesized?.audioFiles || [],
    })

    const durationByStepId = new Map(
      resolvedChapterTitlesForNarration.map((entry) => [String(entry?.sourceScenarioStepId || '').trim(), Math.max(1, Number(entry?.durationMs) || 1)])
    )
    resolvedChapterCards = chapterTitlesForOverlays.map((entry) => {
      const key = String(entry?.sourceScenarioStepId || '').trim()
      const durationMs = Number(durationByStepId.get(key) || entry?.durationMs || 0)
      return {
        ...entry,
        durationMs: Math.max(1, Math.floor(durationMs || 0)),
      }
    })

    // Chapter windows changed; rebuild chapter narrations and replace old chapter entries.
    chapterNarrations = buildChapterNarrationsFromScenario({
      scenarioRoot,
      chapterTitles: resolvedChapterTitlesForNarration,
      profile,
      voiceOverride: ttsVoice,
    })
    effectiveNarrations = [
      ...effectiveNarrations.filter((entry) => String(entry?.sourceKind || '').trim() !== 'chapter'),
      ...chapterNarrations,
    ]
    effectiveNarrations.sort((left, right) => Number(left?.startMs || 0) - Number(right?.startMs || 0))

    // Drop precomputed synth cache so final mux uses audio files aligned with refreshed timing.
    synthesizedNarrations = null
  }

  // Keep timeline strictly ordered before synthesis/mux. Otherwise overflow
  // handling may shift early chapter narrations behind later normal steps.
  effectiveNarrations.sort((left, right) => {
    const startDiff = Number(left?.startMs || 0) - Number(right?.startMs || 0)
    if (startDiff !== 0) return startDiff
    return Number(left?.endMs || 0) - Number(right?.endMs || 0)
  })

  const clickHoldsForMux = clickHolds

  let audioFiles = []
  if (!effectiveNarrations.length) {
    console.log(`[scenario-tts] Keine Didactics fuer Profil "${profileName}" gefunden. Es wird als stummes Remotion-Overlay-Video exportiert.`)
  } else {
    const synthesized = await ensureSynthesizedNarrations()
    audioFiles = applyNarrationTimingToAudioFiles(synthesized.audioFiles, effectiveNarrations)
  }

  const visualOverlays = {
    stepSegments: Array.isArray(visualRemotionPlan?.timeline?.stepSegments)
      ? visualRemotionPlan.timeline.stepSegments
      : [],
    chapterCurtains: Array.isArray(visualRemotionPlan?.timeline?.chapterCurtains)
      ? visualRemotionPlan.timeline.chapterCurtains
      : [],
    clickMarkers: Array.isArray(visualRemotionPlan?.timeline?.clickMarkers)
      ? visualRemotionPlan.timeline.clickMarkers.map((marker) => ({
        ...marker,
        durationMs: Math.max(1, Math.floor((Number(clickIndicatorConfig?.beforeMs || 0) + Number(clickIndicatorConfig?.afterMs || 0)) || 900)),
      }))
      : [],
    chapterCards: resolvedChapterCards,
  }

  console.log(`Mische Profil-Voiceover in Video: ${sourceVideoForTts}`)
  const muxMeta = muxNarrationAudioIntoVideo({
    inputVideo: sourceVideoForTts,
    outputVideo: resolvedOutputVideo,
    audioFiles,
    semanticContext: {
      scenarioRoot,
      timelineReport: artifacts.timeline,
      presentationRange,
      chapterCards: resolvedChapterCards,
      clickMarkers: visualOverlays.clickMarkers,
      clickIndicator: clickIndicatorConfig,
      stepSegments: visualOverlays.stepSegments,
    },
    render: !remotionPlanOnly,
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

  const resolvedTimelinePath = join(ttsOutputDir, `scenario-tts-resolved-${profileToken}-${runId}.json`)
  await writeFile(resolvedTimelinePath, JSON.stringify(resolvedNarrationsForExport, null, 2), 'utf8')

  if (muxMeta?.remotionRenderPlanPath || muxMeta?.remotionRenderScriptTsxPath) {
    const remotionMuxMetaPath = join(ttsOutputDir, `scenario-tts-remotion-render-${profileToken}-${runId}.json`)
    await writeFile(remotionMuxMetaPath, JSON.stringify({
      renderPlanPath: muxMeta?.remotionRenderPlanPath || null,
      semanticVideoPlanPath: muxMeta?.remotionSemanticPlanPath || null,
      renderTsxPath: muxMeta?.remotionRenderScriptTsxPath || null,
      outputVideo: resolvedOutputVideo,
    }, null, 2), 'utf8')
    console.log(`Remotion-Render-Artefakte: ${remotionMuxMetaPath}`)
  }

  const diagnosticsLogPath = join(ttsOutputDir, `scenario-tts-debug-${profileToken}-${runId}.log`)
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
  if (remotionPlanOnly) {
    console.log(`Plan-Modus: Render wurde uebersprungen, kanonisches Kompositionsmodell wurde erstellt.`)
    console.log(`Render-Zielvideo (noch nicht erzeugt): ${resolvedOutputVideo}`)
    return
  }
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
      remotionPlanOnly: parsed.remotionPlanOnly,
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
    const annotateRunsRoot = buildManualRunsRoot(annotateToken)
    const defaultOutput = join(
      annotateRunsRoot,
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
  const runRootDir = join(buildManualRunsRoot(testToken), runId)
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

  const runMetaPath = join(runRootDir, 'run-meta.json')
  let status = testExitCode === 0 ? 'passed' : 'failed'
  let failureReason = null

  if (testExitCode !== 0) {
    failureReason = `Playwright exited with code ${testExitCode}`
  }

  let artifactPair = null
  try {
    artifactPair = await findArtifactPair(outputDir)
    if (!artifactPair) {
      status = 'failed'
      failureReason = failureReason || `Kein Paar aus trace.zip und video.webm unter ${outputDir} gefunden.`
      throw new Error(failureReason)
    }

    console.log(`Gefundener Trace: ${artifactPair.tracePath}`)
    console.log(`Gefundenes Video: ${artifactPair.videoPath}`)

    if (testExitCode !== 0) {
      throw new Error(failureReason)
    }

    await buildAnnotatedArtifacts({
      tracePath: artifactPair.tracePath,
      inputVideo: artifactPair.videoPath,
      demoDir: join(artifactPair.dir, 'demo'),
      resolvedOutputVideo,
      tts,
      ttsVoice,
    })
  } catch (error) {
    status = 'failed'
    failureReason = failureReason || String(error?.message || error)
  }

  await writeFile(runMetaPath, JSON.stringify({
    createdAtIso: new Date().toISOString(),
    runId,
    mode: 'manual-annotated-video',
    status,
    testExitCode,
    failureReason,
    testFile: normalizeWorkspaceRelativePath(testFile),
    artifactDir: normalizeWorkspaceRelativePath(relative(process.cwd(), outputDir)),
    artifactTrace: artifactPair ? normalizeWorkspaceRelativePath(relative(process.cwd(), artifactPair.tracePath)) : null,
    artifactVideo: artifactPair ? normalizeWorkspaceRelativePath(relative(process.cwd(), artifactPair.videoPath)) : null,
    outputVideo: normalizeWorkspaceRelativePath(relative(process.cwd(), resolvedOutputVideo)),
    outputVideoRaw: normalizeWorkspaceRelativePath(relative(process.cwd(), introlessOutputVideo)),
  }, null, 2), 'utf8')

  if (status !== 'passed') {
    throw new Error(failureReason || `Run failed for ${testFile}`)
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
