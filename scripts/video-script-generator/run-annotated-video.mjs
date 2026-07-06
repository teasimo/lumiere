#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { XMLParser } from 'fast-xml-parser'
import {
  buildRemotionRenderPlan,
  buildSemanticRemotionTsx,
  buildSemanticVideoPlan,
} from './semantic-remotion.mjs'
import {
  buildAzureSpeechAuthContext,
  buildAzureSpeechSsml as buildSharedAzureSpeechSsml,
  DEFAULT_AZURE_TTS_OUTPUT_FORMAT,
  DEFAULT_AZURE_TTS_VOICE,
  normalizeAzureTtsVoiceName,
  resolveAzureSpeechEndpoint,
} from '../shared/azure-speech.mjs'
import { getVideoScriptConfig, loadCentralConfig } from '../shared/central-config.mjs'
import {
  buildPersistentScenarioArtifactsRoot,
  buildScenarioArtifactVersionPathSegment,
  buildScenarioArtifactVersionToken,
  buildScenarioOutputFolderName,
  buildScenarioOutputRoot,
  sanitizeScenarioOutputToken,
} from '../shared/scenario-output.mjs'
import { appendFragmentSourceArg, normalizeFragmentSource, resolveFragmentSourceForScenario } from '../shared/lunettes-fragment-source.mjs'
import { buildScenarioXmlGeneratorInvocation } from '../shared/scenario-xml-generator.mjs'

const OUTPUT_ROOT = resolve('output')
const OUTPUT_VIDEOGENERATOR_SCOPE_DIR = 'videogenerator'
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
const DEFAULT_VIDEO_INTRO_PATH = resolve('neo', 'assets', 'video-intro.mp4')
const SCENARIO_SCRIPT_XSD_PATH = resolve('schemas', 'szenarioscript.xsd')
const SEMANTIC_VIDEO_PLAN_SCHEMA_PATH = resolve('schemas', 'lumiere-semantic-video-plan.schema.json')

function resolveChapterFadeInDurationMs(chapterDurationMs) {
  const durationSec = Math.max(1, Number(chapterDurationMs || 0) / 1000)
  return Math.max(0, Math.round(Math.min(DEMO_INTRO_FADE_DURATION_SEC, durationSec / 3) * 1000))
}

function printUsage() {
  console.log(`Verwendung:
  node scripts/video-script-generator/run-annotated-video.mjs --scenario-tts <scenario.xml> --profile=<profil> [output.mp4] [--software=<name>] [--tts-voice=<name>]
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
  node scripts/video-script-generator/run-annotated-video.mjs --annotate-only ../output/my-scenario/runs/20260425191328/artifacts/trace.zip ../output/my-scenario/runs/20260425191328/artifacts/video.webm ../output/my-scenario/runs/20260425191328/artifacts/demo annotated.mp4 --tts
  node scripts/video-script-generator/run-annotated-video.mjs tests/e2e/idee-flow.spec.js --project=chromium --tts
  node scripts/video-script-generator/run-annotated-video.mjs --tts-only output/idee-flow-spec/videogenerator/20260425191328/final/idee-flow-spec-annotated-20260425191328.mp4 output/idee-flow-spec/videogenerator/20260425191328/artifacts/demo --tts-voice=de-DE-Neural2-B
  npm run test:e2e:annotated-video -- tests/e2e/idee-planungsanker-plaintext-flow.spec.js --project=chromium
`)
}

function buildVideoGeneratorRoot(nameToken) {
  return join(
    OUTPUT_ROOT,
    buildScenarioOutputFolderName({ scenarioId: nameToken, fallbackName: 'scenario' }),
    OUTPUT_VIDEOGENERATOR_SCOPE_DIR,
  )
}

function buildCanonicalScenarioVideoFilename({ scenarioId, scenarioVersion }) {
  const normalizedScenarioId = sanitizeFileToken(scenarioId, 'scenario')
  const normalizedVersion = buildScenarioArtifactVersionToken(scenarioVersion)
  return `szenario-${normalizedScenarioId}-${normalizedVersion}.mp4`
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
    let scenarioId = null
    let scenarioVersion = null
    let fragmentSource = 'local'
    let software = null
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
      if (arg.startsWith('--scenario-id=')) {
        scenarioId = arg.slice('--scenario-id='.length).trim()
        continue
      }
      if (arg.startsWith('--scenario-version=')) {
        scenarioVersion = arg.slice('--scenario-version='.length).trim()
        continue
      }
      if (arg.startsWith('--fragment-source=')) {
        fragmentSource = arg.slice('--fragment-source='.length).trim()
        continue
      }
      if (arg.startsWith('--software=')) {
        software = arg.slice('--software='.length).trim()
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
      scenarioId,
      scenarioVersion,
      software,
      fragmentSource: resolveFragmentSourceForScenario(fragmentSource, scenarioPath, 'lunettes'),
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

const RAW_VIDEO_IGNORE_KEYS = new Set([
  'presentation',
  'didactics',
  'didactic',
  'chapter',
  'kapitel',
  'slide',
  'folie',
  'info',
  'schritt',
])

function shouldIgnoreRawVideoComparableKey(key) {
  const normalized = String(key || '').trim().toLowerCase()
  return RAW_VIDEO_IGNORE_KEYS.has(normalized)
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
    if (key === '#comment' || key === '#cdata') {
      continue
    }
    if (key === '#text') {
      const normalizedText = typeof entry === 'string'
        ? entry.replace(/\s+/g, ' ').trim()
        : ''
      if (!normalizedText) {
        continue
      }
      result[key] = normalizedText
      continue
    }
    if (shouldIgnoreRawVideoComparableKey(key)) {
      continue
    }
    result[key] = stripPresentationDeep(entry)
  }

  return result
}

function buildRawVideoComparableFromXml(xmlRaw) {
  const parser = new XMLParser({
    preserveOrder: false,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })
  const parsed = parser.parse(String(xmlRaw || ''))
  const root = parsed?.interaction || parsed || {}
  return toCanonicalComparable(stripPresentationDeep(root))
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

function ensureResolvedJsonForScenarioXml(scenarioAbsolutePath, options = {}) {
  const generatorInvocation = buildScenarioXmlGeneratorInvocation({
    scenarioPath: scenarioAbsolutePath,
    outDir: 'temp/testfiles',
    fragmentSource: options.fragmentSource,
  })
  const exitCode = runCommand(generatorInvocation.command, generatorInvocation.args)

  if (exitCode !== 0) {
    throw new Error(`Szenario konnte nicht aus XML aufgeloest werden: ${scenarioAbsolutePath}`)
  }

  if (!existsSync(generatorInvocation.paths.resolvedJsonPath)) {
    throw new Error(`Resolved JSON fehlt nach XML-Generierung: ${generatorInvocation.paths.resolvedJsonPath}`)
  }

  return generatorInvocation.paths.resolvedJsonPath
}

function getResolvedXmlPathForScenarioXml(scenarioAbsolutePath) {
  return buildScenarioXmlGeneratorInvocation({
    scenarioPath: scenarioAbsolutePath,
    outDir: 'temp/testfiles',
  }).paths.resolvedXmlPath
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

function resolveInfoType(value) {
  const normalized = String(value || '').trim()
  return normalized || 'Erklärung'
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
        if (lastInteractionResolvedId) {
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

function collectXmlTextContent(nodes) {
  let text = ''
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      continue
    }

    if (typeof node['#text'] === 'string') {
      text += node['#text']
    }

    const tag = getXmlNodeTag(node)
    if (!tag) {
      continue
    }

    const payload = node[tag]
    if (Array.isArray(payload) && payload.length > 0) {
      text += collectXmlTextContent(payload)
    }
  }

  return text
}

function buildFlowStepIndexByResolvedId(flowEntries, index = new Map()) {
  for (const step of flowEntries || []) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      continue
    }

    const resolvedId = String(step.resolvedId || '').trim()
    if (resolvedId && !index.has(resolvedId)) {
      index.set(resolvedId, step)
    }

    if (Array.isArray(step.flow) && step.flow.length > 0) {
      buildFlowStepIndexByResolvedId(step.flow, index)
    }
  }

  return index
}

function annotateScenarioPresentationFromResolvedXml(scenarioRoot, resolvedXmlRaw) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  if (!flow.length || !resolvedXmlRaw) {
    return
  }

  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })

  const parsed = parser.parse(String(resolvedXmlRaw || ''))
  const flowStepByResolvedId = buildFlowStepIndexByResolvedId(flow)
  const interactionTags = new Set(['Click', 'Eingabe', 'Auswahl', 'Anzeige', 'Warten', 'Oeffnen', 'SucheAuswahl', 'Scroll'])
  const pendingSlides = []
  let pendingChapter = ''
  let currentStepTitle = ''
  // Tracks <Info> tags pending assignment to the next interaction step
  const pendingInfoQueue = [] // { typ, text, interaktion }
  // Tracks <Info> tags that should play on the next chapter/slide intro freeze
  const pendingPresentationInfoQueue = [] // { typ, text, interaktion }
  // Last interaction step seen (for interaktion="vorige"/"danach")
  let lastInteractionStep = null
  let inVideoSegment = false
  let nextPresentationGroupIndex = 1

  function resetPendingPresentationState() {
    pendingSlides.length = 0
    pendingChapter = ''
    currentStepTitle = ''
    pendingInfoQueue.length = 0
    pendingPresentationInfoQueue.length = 0
    lastInteractionStep = null
  }

  function visitNodes(nodes, groupContext = null) {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        continue
      }

      const tag = getXmlNodeTag(node)
      if (!tag) {
        continue
      }

      const payload = node[tag]
      const payloadNodes = Array.isArray(payload) ? payload : []
      const text = collectXmlTextContent(payloadNodes)
        .replace(/\s+/g, ' ')
        .trim()

      if (tag === 'Gruppe') {
        const nestedGroupContext = inVideoSegment ? {
          index: nextPresentationGroupIndex,
          duringInfos: [],
          firstInteractionAssigned: false,
        } : groupContext
        if (inVideoSegment) {
          nextPresentationGroupIndex += 1
        }
        if (payloadNodes.length > 0) {
          visitNodes(payloadNodes, nestedGroupContext)
        }
        continue
      } else if (tag === 'VideoStart') {
        resetPendingPresentationState()
        inVideoSegment = true
      } else if (tag === 'VideoStop') {
        if (inVideoSegment && pendingInfoQueue.length > 0 && lastInteractionStep) {
          if (!Array.isArray(lastInteractionStep.infoAnnotations)) {
            lastInteractionStep.infoAnnotations = []
          }
          lastInteractionStep.infoAnnotations.push(...pendingInfoQueue.splice(0))
        }
        inVideoSegment = false
        resetPendingPresentationState()
      } else if (tag === 'Kapitel' && text && inVideoSegment) {
        if (pendingInfoQueue.length > 0) {
          pendingPresentationInfoQueue.push(...pendingInfoQueue.splice(0))
        }
        pendingChapter = text
      } else if (tag === 'Schritt' && text && inVideoSegment) {
        currentStepTitle = text
      } else if (tag === 'Folie' && text && inVideoSegment) {
        if (pendingInfoQueue.length > 0) {
          pendingPresentationInfoQueue.push(...pendingInfoQueue.splice(0))
        }
        pendingSlides.push(text)
      } else if (tag === 'Info' && text && inVideoSegment) {
        const attrs = node[':@'] || {}
        const typ = resolveInfoType(attrs['@_typ'])
        const interaktion = String(attrs['@_interaktion'] || '').trim().toLowerCase()
        const entry = { typ, text, interaktion: interaktion || null }
        if (interaktion === 'währenddessen' && groupContext) {
          groupContext.duringInfos.push(entry)
        } else if (interaktion === 'vorige' || interaktion === 'danach') {
          // Attach to the preceding interaction step
          if (lastInteractionStep) {
            if (!Array.isArray(lastInteractionStep.infoAnnotations)) {
              lastInteractionStep.infoAnnotations = []
            }
            lastInteractionStep.infoAnnotations.push(entry)
          }
        } else {
          // Defer to the next interaction step (währenddessen or no interaktion)
          pendingInfoQueue.push(entry)
        }
      } else if (interactionTags.has(tag) && inVideoSegment) {
        const attrs = node[':@'] || {}
        const resolvedId = String(attrs['@_resolved-id'] || '').trim()
        const step = flowStepByResolvedId.get(resolvedId)
        if (step && typeof step === 'object') {
          if (groupContext?.index != null) {
            step.presentationGroupIndex = groupContext.index
          }
          if (pendingChapter && (!step.chapter || typeof step.chapter !== 'object')) {
            step.chapter = { text: pendingChapter }
            pendingChapter = ''
          }
          if (currentStepTitle && !String(step.title || '').trim()) {
            step.title = currentStepTitle
          }
          if (pendingSlides.length > 0 && (!step.slide || typeof step.slide !== 'object')) {
            step.slide = { text: pendingSlides.shift() }
          }
          if (pendingPresentationInfoQueue.length > 0) {
            if (!Array.isArray(step.presentationInfoAnnotations)) {
              step.presentationInfoAnnotations = []
            }
            step.presentationInfoAnnotations.push(...pendingPresentationInfoQueue.splice(0))
          }
          if (groupContext && Array.isArray(groupContext.duringInfos) && groupContext.duringInfos.length > 0 && groupContext.firstInteractionAssigned !== true) {
            if (!Array.isArray(step.groupDuringInfoAnnotations)) {
              step.groupDuringInfoAnnotations = []
            }
            step.groupDuringInfoAnnotations.push(...groupContext.duringInfos)
            groupContext.firstInteractionAssigned = true
          }
          // Assign pending Info annotations (before/währenddessen) to this step
          if (pendingInfoQueue.length > 0) {
            if (!Array.isArray(step.infoAnnotations)) {
              step.infoAnnotations = []
            }
            step.infoAnnotations.push(...pendingInfoQueue.splice(0))
          }
          lastInteractionStep = step
        }
      }

      if (payloadNodes.length > 0) {
        visitNodes(payloadNodes, groupContext)
      }
    }
  }

  visitNodes(Array.isArray(parsed) ? parsed : [])
}

function extractScenarioTagLineIndices(scenarioXmlRaw) {
  const lines = String(scenarioXmlRaw || '').split(/\r?\n/)
  const chapterLines = []
  const slideLines = []
  const stepLines = []
  const clickLines = []
  const fragmentRanges = []
  const fragmentStartStack = []

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    const line = String(lines[index] || '')

    if (/<Kapitel\b/i.test(line)) {
      chapterLines.push(lineNo)
    }
    if (/<Folie\b/i.test(line)) {
      slideLines.push(lineNo)
    }
    if (/<Schritt\b/i.test(line)) {
      stepLines.push(lineNo)
    }
    if (/<Click\b/i.test(line)) {
      clickLines.push(lineNo)
    }

    if (/<Fragment\b[^>]*\/\s*>/i.test(line)) {
      fragmentRanges.push({
        start: lineNo,
        end: lineNo,
      })
    } else if (/<Fragment\b/i.test(line)) {
      fragmentStartStack.push(lineNo)
    }

    if (/<\/Fragment\s*>/i.test(line)) {
      const start = fragmentStartStack.pop() || lineNo
      fragmentRanges.push({
        start,
        end: lineNo,
      })
    }
  }

  return {
    chapterLines,
    slideLines,
    stepLines,
    clickLines,
    fragmentRanges,
  }
}

function formatRowIndexRange(range) {
  if (!range || typeof range !== 'object') {
    return null
  }
  const start = Math.max(1, Math.floor(Number(range.start) || 0))
  const end = Math.max(start, Math.floor(Number(range.end) || start))
  return `${start}-${end}`
}

function isClickFlowStep(step) {
  if (!step || typeof step !== 'object') {
    return false
  }

  const interactionType = String(step?.interaction?.type || '').trim().toLowerCase()
  if (interactionType === 'click') {
    return true
  }

  return typeof step.click === 'object' && step.click !== null
}

function annotateScenarioFlowRowIndices(scenarioRoot, scenarioXmlRaw) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  if (!flow.length) {
    return
  }

  const indices = extractScenarioTagLineIndices(scenarioXmlRaw)
  const cursors = {
    chapter: 0,
    slide: 0,
    step: 0,
    click: 0,
    fragment: 0,
  }

  let currentStepLine = null
  let previousTitle = null

  function nextLine(listName) {
    const list = indices[listName]
    const cursorKey = listName.replace('Lines', '')
    const cursor = cursors[cursorKey]
    if (!Array.isArray(list) || cursor >= list.length) {
      return null
    }
    cursors[cursorKey] += 1
    return Math.max(1, Math.floor(Number(list[cursor]) || 0))
  }

  function nextFragmentRange() {
    const range = indices.fragmentRanges[cursors.fragment] || null
    if (range) {
      cursors.fragment += 1
    }
    return range
  }

  function visit(entries, inheritedFragmentRange = null) {
    for (const step of entries || []) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        continue
      }

      let rowIndex = null
      const title = String(step?.title || '').trim()
      if (title && title !== previousTitle) {
        const stepLine = nextLine('stepLines')
        if (stepLine != null) {
          currentStepLine = stepLine
        }
        previousTitle = title
      }

      if (step.chapter && typeof step.chapter === 'object') {
        const chapterLine = nextLine('chapterLines')
        if (chapterLine != null) {
          step.chapter['row-index'] = chapterLine
          rowIndex = chapterLine
        }
      }

      if (step.slide && typeof step.slide === 'object') {
        const slideLine = nextLine('slideLines')
        if (slideLine != null) {
          step.slide['row-index'] = slideLine
          rowIndex = rowIndex ?? slideLine
        }
      }

      const localFragmentRange = step.include ? (nextFragmentRange() || inheritedFragmentRange) : inheritedFragmentRange

      if (isClickFlowStep(step)) {
        const clickRowIndex = localFragmentRange
          ? formatRowIndexRange(localFragmentRange)
          : (nextLine('clickLines') ?? currentStepLine)
        if (clickRowIndex != null) {
          rowIndex = clickRowIndex
          if (step.interaction && typeof step.interaction === 'object') {
            step.interaction['row-index'] = clickRowIndex
          }
          if (step.click && typeof step.click === 'object') {
            step.click['row-index'] = clickRowIndex
          }
        }
      }

      if (rowIndex == null && currentStepLine != null) {
        rowIndex = currentStepLine
      }

      if (rowIndex != null) {
        step['row-index'] = rowIndex
      }

      if (Array.isArray(step.flow) && step.flow.length > 0) {
        visit(step.flow, localFragmentRange)
      }
    }
  }

  visit(flow)
}

async function loadScenarioRootForTts(scenarioAbsolutePath, options = {}) {
  const extension = extname(scenarioAbsolutePath).toLowerCase()
  if (extension !== '.xml') {
    throw new Error('Nur XML-Szenarien werden unterstuetzt. Bitte eine .xml-Datei uebergeben.')
  }

  const resolvedJsonPath = ensureResolvedJsonForScenarioXml(scenarioAbsolutePath, options)
  const resolvedXmlPath = getResolvedXmlPathForScenarioXml(scenarioAbsolutePath)
  const resolvedJsonRaw = await readFile(resolvedJsonPath, 'utf8')
  const resolvedJsonParsed = JSON.parse(resolvedJsonRaw)
  const scenarioRoot = resolvedJsonParsed.interaction || resolvedJsonParsed
  const scenarioXmlRaw = await readFile(scenarioAbsolutePath, 'utf8')
  const resolvedXmlRaw = existsSync(resolvedXmlPath) ? await readFile(resolvedXmlPath, 'utf8') : ''
  annotateScenarioPresentationFromResolvedXml(scenarioRoot, resolvedXmlRaw)
  annotateScenarioFlowRowIndices(scenarioRoot, scenarioXmlRaw)
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
    currentJson = JSON.stringify(buildRawVideoComparableFromXml(currentRaw))
    snapshotJson = JSON.stringify(buildRawVideoComparableFromXml(snapshotRaw))
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
      'Das aktuelle Szenario passt nicht mehr zum vorhandenen Rohvideo (Vergleich ignoriert presentation/slide/info/chapter/schritt).',
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

function resolveScenarioClickIndicatorConfig(scenarioRoot, videoScriptConfig = {}) {
  const centralClickConfig = videoScriptConfig?.presentation?.indicators?.click
  const scenarioClickConfig = scenarioRoot?.presentation?.indicators?.click
  const clickConfig = {
    ...(centralClickConfig && typeof centralClickConfig === 'object' ? centralClickConfig : {}),
    ...(scenarioClickConfig && typeof scenarioClickConfig === 'object' ? scenarioClickConfig : {}),
  }

  const enabled = clickConfig.enabled !== false
  const beforeMs = Math.max(0, Number(clickConfig.before_ms ?? 100) || 100)
  const afterMs = Math.max(0, Number(clickConfig.after_ms ?? 100) || 100)
  const fadeMs = Math.max(0, Number(clickConfig.fade_ms ?? 50) || 50)

  return {
    enabled,
    beforeMs,
    afterMs,
    fadeMs,
  }
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
      startDirectiveStepId = videoScriptRange?.startResolvedId || videoStartStepId
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
  const resolvedInput = resolve(String(inputVideo || ''))
  const resolvedOutput = resolve(String(outputVideo || ''))
  if (!resolvedInput || !resolvedOutput || resolvedInput === resolvedOutput) {
    return
  }

  writeFileSync(resolvedOutput, readFileSync(resolvedInput))
}

function buildNarrationsFromScenarioTimeline({ scenarioRoot, timelineReport, profile, voiceOverride = null }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const steps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  if (!steps.length) {
    throw new Error('Timeline enthaelt keine Schritte.')
  }

  const flattenedFlowStepEntries = flattenFlowSteps(flow)
  // Secondary lookup by resolvedId for annotation-based narrations (Info tags).
  // The timeline uses resolvedIds (e.g. "R0107") while flattenFlowSteps uses
  // human-readable step ids, so resolveScenarioStepMatchForTimelineStep may not
  // find a match. Fall back to the resolvedId index for infoAnnotations access.
  const flowStepByResolvedId = buildFlowStepIndexByResolvedId(flow)
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
  const groupWindowByIndex = new Map()

  for (const timelineStep of sortedSteps) {
    const timelineStepId = String(timelineStep?.stepId || '').trim()
    if (!timelineStepId) continue
    const groupStepEntry = flowStepByResolvedId.get(timelineStepId)
    const groupIndex = Number(groupStepEntry?.presentationGroupIndex)
    if (!Number.isFinite(groupIndex)) continue

    const startedAtMs = Number(timelineStep?.startedAtMs)
    const endedAtMs = Number(timelineStep?.endedAtMs)
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
      continue
    }

    const existingWindow = groupWindowByIndex.get(groupIndex)
    if (!existingWindow) {
      groupWindowByIndex.set(groupIndex, {
        startAbsMs: startedAtMs,
        endAbsMs: endedAtMs,
        firstStepId: timelineStepId,
        lastStepId: timelineStepId,
      })
      continue
    }

    existingWindow.startAbsMs = Math.min(existingWindow.startAbsMs, startedAtMs)
    existingWindow.endAbsMs = Math.max(existingWindow.endAbsMs, endedAtMs)
    if (startedAtMs <= existingWindow.startAbsMs) {
      existingWindow.firstStepId = timelineStepId
    }
    if (endedAtMs >= existingWindow.endAbsMs) {
      existingWindow.lastStepId = timelineStepId
    }
  }

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

    // Fallback: resolve step by resolvedId for infoAnnotations (timeline uses resolvedIds
    // but flattenFlowSteps in this file uses human-readable ids which don't match).
    const stepEntryByResolvedId = flowStepByResolvedId.get(stepId) || null

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

    const presentationInfoAnnotations = Array.isArray(stepEntryByResolvedId?.presentationInfoAnnotations)
      ? stepEntryByResolvedId.presentationInfoAnnotations
      : Array.isArray(stepEntry?.presentationInfoAnnotations) ? stepEntry.presentationInfoAnnotations : []
    for (const info of presentationInfoAnnotations) {
      const typ = resolveInfoType(info?.typ)
      const infoText = String(info?.text || '').trim()
      if (!infoText) continue

      const channelConfig = channelsConfig[typ]
      if (!channelConfig || channelConfig.enabled !== true) continue

      const prefix = typeof channelConfig.prefix === 'string' ? channelConfig.prefix.trim() : ''
      const spokenText = prefix ? `${prefix} ${infoText}` : infoText
      const startMs = Math.max(0, Math.floor(stepStartMs))
      const endMs = Math.max(startMs + 1, Math.floor(startMs + minWindowMs))

      narrations.push({
        id: `${narrationStepId}-info-presentation-${typ}`,
        startMs,
        endMs,
        text: spokenText,
        sourceTimelineStepId: narrationStepId,
        sourceScenarioStepId: matchedStepId || stepId,
        sourceAnchor: 'info-presentation',
        voice: voiceOverride || profileVoice || undefined,
      })
    }

    const groupDuringInfoAnnotations = Array.isArray(stepEntryByResolvedId?.groupDuringInfoAnnotations)
      ? stepEntryByResolvedId.groupDuringInfoAnnotations
      : Array.isArray(stepEntry?.groupDuringInfoAnnotations) ? stepEntry.groupDuringInfoAnnotations : []
    const presentationGroupIndex = Number(stepEntryByResolvedId?.presentationGroupIndex ?? stepEntry?.presentationGroupIndex)
    const groupWindow = Number.isFinite(presentationGroupIndex) ? groupWindowByIndex.get(presentationGroupIndex) : null
    for (const info of groupDuringInfoAnnotations) {
      const typ = resolveInfoType(info?.typ)
      const infoText = String(info?.text || '').trim()
      if (!infoText) continue

      const channelConfig = channelsConfig[typ]
      if (!channelConfig || channelConfig.enabled !== true) continue

      const prefix = typeof channelConfig.prefix === 'string' ? channelConfig.prefix.trim() : ''
      const spokenText = prefix ? `${prefix} ${infoText}` : infoText
      const groupStartMs = groupWindow
        ? Math.max(0, Math.floor(Number(groupWindow.startAbsMs || 0) - originMs))
        : stepStartMs
      const groupEndMs = groupWindow
        ? Math.max(groupStartMs + 1, Math.floor(Number(groupWindow.endAbsMs || 0) - originMs))
        : Math.max(groupStartMs + 1, stepEndMs)

      narrations.push({
        id: `${String(groupWindow?.firstStepId || narrationStepId).trim() || narrationStepId}-info-during-${typ}`,
        startMs: groupStartMs,
        endMs: groupEndMs,
        text: spokenText,
        sourceTimelineStepId: String(groupWindow?.firstStepId || narrationStepId).trim() || narrationStepId,
        sourcePauseTimelineStepId: String(groupWindow?.lastStepId || narrationStepId).trim() || narrationStepId,
        sourceScenarioStepId: matchedStepId || stepId,
        sourceAnchor: 'info-during',
        voice: voiceOverride || profileVoice || undefined,
      })
    }

    // Process <Info> annotations with explicit interaktion placement.
    // Use stepEntryByResolvedId as primary source since infoAnnotations are keyed
    // to flow steps via resolvedId (the same id used by the timeline).
    const infoAnnotations = Array.isArray(stepEntryByResolvedId?.infoAnnotations)
      ? stepEntryByResolvedId.infoAnnotations
      : Array.isArray(stepEntry?.infoAnnotations) ? stepEntry.infoAnnotations : []
    for (const info of infoAnnotations) {
      const typ = resolveInfoType(info?.typ)
      const interaktion = String(info?.interaktion || '').trim().toLowerCase()
      const infoText = String(info?.text || '').trim()
      if (!infoText) continue

      const channelConfig = channelsConfig[typ]
      if (!channelConfig || channelConfig.enabled !== true) continue

      const prefix = typeof channelConfig.prefix === 'string' ? channelConfig.prefix.trim() : ''
      const spokenText = prefix ? `${prefix} ${infoText}` : infoText

      let baseMs
      let anchor
      if (interaktion === 'vorige' || interaktion === 'danach') {
        // Play after this step ends, with freeze on last frame
        baseMs = stepEndMs + afterActionMs
        anchor = 'info-after'
      } else if (interaktion === 'währenddessen') {
        continue
      } else {
        // No explicit interaktion means: attach to the upcoming step and freeze
        // on its first visible frame while the narration plays.
        baseMs = stepStartMs
        anchor = 'info-before'
      }

      const startMs = Math.max(0, Math.floor(baseMs))
      const endMs = Math.max(startMs + 1, Math.floor(startMs + minWindowMs))

      narrations.push({
        id: `${narrationStepId}-${anchor}-${typ}`,
        startMs,
        endMs,
        text: spokenText,
        sourceTimelineStepId: narrationStepId,
        sourceScenarioStepId: matchedStepId || stepId,
        sourceAnchor: anchor,
        voice: voiceOverride || profileVoice || undefined,
      })
    }
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

function resolveNarrationFreezeConfig(profile) {
  const pauses = profile?.pauses && typeof profile.pauses === 'object' ? profile.pauses : {}
  return {
    beforeMs: Math.max(0, Number(
      pauses.narration_freeze_before_ms
      ?? pauses.tts_freeze_before_ms
      ?? pauses.freeze_before_tts_ms
      ?? 0,
    ) || 0),
    afterMs: Math.max(0, Number(
      pauses.narration_freeze_after_ms
      ?? pauses.tts_freeze_after_ms
      ?? pauses.freeze_after_tts_ms
      ?? 0,
    ) || 0),
  }
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
    slideText: typeof stepEntry?.slide?.text === 'string' ? stepEntry.slide.text.trim() : '',
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

    const scenarioStepId = String(flowEntry?.id || '').trim()
    const resolvedStepId = String(stepEntry?.resolvedId || '').trim()
    const timelineCandidateIds = [resolvedStepId, scenarioStepId].filter(Boolean)
    const chapterStepId = timelineCandidateIds[0] || ''
    if (!chapterStepId) {
      continue
    }

    let window = null
    for (const candidateId of timelineCandidateIds) {
      window = resolvePresentationStepWindowMs(candidateId, sortedSteps)
      if (window) {
        break
      }
    }

    if (!window) {
      for (let nextIndex = index + 1; nextIndex < flattenedFlowStepEntries.length; nextIndex += 1) {
        const nextScenarioId = String(flattenedFlowStepEntries[nextIndex]?.id || '').trim()
        const nextResolvedId = String(flattenedFlowStepEntries[nextIndex]?.step?.resolvedId || '').trim()
        const nextCandidates = [nextResolvedId, nextScenarioId].filter(Boolean)
        if (nextCandidates.length === 0) {
          continue
        }

        for (const nextId of nextCandidates) {
          window = resolvePresentationStepWindowMs(nextId, sortedSteps)
          if (window) {
            break
          }
        }
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
      slideText: chapterCard.slideText,
      'row-index': stepEntry?.chapter?.['row-index'] ?? stepEntry?.['row-index'] ?? null,
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

async function findPersistentScenarioVideoTimelinePair({
  workspaceRoot,
  scenarioId,
  scenarioVersion,
  scenarioPathRelative,
}) {
  const persistentRoot = buildPersistentScenarioArtifactsRoot(workspaceRoot, scenarioId, scenarioVersion, 'testscript')
  const videoPath = join(persistentRoot, 'rohvideo', 'video.webm')
  const timelinePath = join(persistentRoot, 'timeline', 'scenario-step-timeline.json')
  if (!existsSync(videoPath) || !existsSync(timelinePath)) {
    return null
  }

  const timeline = await readJsonIfExists(timelinePath)
  const source = normalizeWorkspaceRelativePath(timeline?.scenarioSource)
  if (source !== normalizeWorkspaceRelativePath(scenarioPathRelative)) {
    return null
  }

  const timelineStat = await stat(timelinePath)
  return {
    dir: persistentRoot,
    videoPath,
    timelinePath,
    timeline,
    mtimeMs: timelineStat.mtimeMs,
    sourceType: 'persistent',
  }
}

async function ensureScenarioVideoTimelinePair({ scenarioId, scenarioVersion, scenarioPathRelative }) {
  const existing = await findPersistentScenarioVideoTimelinePair({
    workspaceRoot: process.cwd(),
    scenarioId,
    scenarioVersion,
    scenarioPathRelative,
  })
  if (existing) {
    return existing
  }

  throw new Error([
    'Kein vorhandenes Rohvideo fuer das Szenario gefunden.',
    `Erwartet unter szenario/${scenarioId}/${buildScenarioArtifactVersionPathSegment({ scenarioId, scenarioVersion })}/testscript mit scenarioSource=${scenarioPathRelative}.`,
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

function normalizeTimelineVideoSegments(timelineReport) {
  const directSegments = Array.isArray(timelineReport?.video?.stepSegments)
    ? timelineReport.video.stepSegments
    : []

  if (directSegments.length > 0) {
    return directSegments
      .map((segment, index) => {
        const startMs = Math.max(0, Math.round(Number(segment?.startMs ?? segment?.startedAtMs ?? 0) || 0))
        const endMs = Math.max(startMs + 1, Math.round(Number(segment?.endMs ?? segment?.endedAtMs ?? startMs + 1) || (startMs + 1)))
        return {
          stepId: String(segment?.stepId || '').trim() || `timeline-step-${index + 1}`,
          label: String(segment?.label || segment?.stepDescription || segment?.stepId || `Step ${index + 1}`).trim(),
          interactionType: segment?.interactionType == null ? null : String(segment.interactionType),
          startMs,
          endMs,
        }
      })
      .filter((segment) => segment.endMs > segment.startMs)
  }

  return (Array.isArray(timelineReport?.steps) ? timelineReport.steps : [])
    .map((step, index) => {
      const startMs = Math.max(0, Math.round(Number(step?.startedAtMs || 0) || 0))
      const endMs = Math.max(startMs + 1, Math.round(Number(step?.endedAtMs || startMs + 1) || (startMs + 1)))
      return {
        stepId: String(step?.stepId || '').trim() || `timeline-step-${index + 1}`,
        label: String(step?.stepDescription || step?.stepId || `Step ${index + 1}`).trim(),
        interactionType: step?.interactionType == null ? null : String(step.interactionType),
        startMs,
        endMs,
      }
    })
    .filter((segment) => segment.endMs > segment.startMs)
}

function normalizeTimelineClickMarkers(timelineReport) {
  const directMarkers = Array.isArray(timelineReport?.video?.clickMarkers)
    ? timelineReport.video.clickMarkers
    : []

  const normalizedDirectMarkers = directMarkers
    .map((marker) => {
      const x = Number(marker?.x)
      const y = Number(marker?.y)
      const atMs = Number(marker?.atMs ?? marker?.timeMs)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(atMs)) {
        return null
      }
      return {
        stepId: String(marker?.stepId || '').trim() || null,
        interactionType: marker?.interactionType == null ? null : String(marker.interactionType),
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        atMs: Math.max(0, Math.round(atMs)),
      }
    })
    .filter(Boolean)

  const stepMarkers = (Array.isArray(timelineReport?.steps) ? timelineReport.steps : [])
    .map((step) => {
      const interactionType = String(step?.interactionType || '').trim().toLowerCase()
      const point = step?.clickPoint || step?.fillPoint
      const x = Number(point?.x)
      const y = Number(point?.y)
      const clickedAtMs = Number(step?.clickedAtMs)
      const startedAtMs = Number(step?.startedAtMs)
      const endedAtMs = Number(step?.endedAtMs)
      const fallbackAtMs = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
        ? startedAtMs + Math.max(0, Math.round((endedAtMs - startedAtMs) / 2))
        : Number.isFinite(startedAtMs)
          ? startedAtMs
          : endedAtMs
      const atMs = Number.isFinite(clickedAtMs) ? clickedAtMs : fallbackAtMs
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(atMs)) {
        return null
      }
      return {
        stepId: String(step?.stepId || '').trim() || null,
        interactionType: interactionType || (step?.interactionType == null ? null : String(step.interactionType)),
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        atMs: Math.max(0, Math.round(atMs)),
      }
    })
    .filter(Boolean)

  const markersByStep = new Map()
  for (const marker of [...normalizedDirectMarkers, ...stepMarkers]) {
    const key = marker.stepId
      ? `${marker.stepId}::${marker.interactionType || ''}`
      : `${marker.x}:${marker.y}:${marker.atMs}:${marker.interactionType || ''}`
    if (!markersByStep.has(key)) {
      markersByStep.set(key, marker)
    }
  }

  return [...markersByStep.values()]
}

function resolveTimelineOriginMs(timelineReport) {
  const steps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  for (const step of steps) {
    const startedAtMs = Number(step?.startedAtMs)
    if (Number.isFinite(startedAtMs) && startedAtMs >= 0) {
      return Math.max(0, Math.round(startedAtMs))
    }
  }
  return 0
}

function scaleTimelinePointToVideo({ x, y, viewport, videoDimensions }) {
  const rawX = Math.max(0, Number(x || 0))
  const rawY = Math.max(0, Number(y || 0))
  const viewportWidth = Math.max(0, Number(viewport?.width || 0))
  const viewportHeight = Math.max(0, Number(viewport?.height || 0))
  const videoWidth = Math.max(0, Number(videoDimensions?.width || 0))
  const videoHeight = Math.max(0, Number(videoDimensions?.height || 0))

  if (viewportWidth <= 0 || viewportHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) {
    return { x: rawX, y: rawY }
  }

  return {
    x: Math.max(0, Math.min(videoWidth, rawX * (videoWidth / viewportWidth))),
    y: Math.max(0, Math.min(videoHeight, rawY * (videoHeight / viewportHeight))),
  }
}

export function buildVisualTimelineFromScenarioTimeline({ timelineReport, clickIndicatorConfig = null }) {
  const stepSegments = normalizeTimelineVideoSegments(timelineReport)
  const clickMarkers = clickIndicatorConfig?.enabled === true
    ? normalizeTimelineClickMarkers(timelineReport)
    : []
  const clickDurationMs = Math.max(0, Math.floor((Number(clickIndicatorConfig?.beforeMs || 0) + Number(clickIndicatorConfig?.afterMs || 0))))
  const clickHolds = clickDurationMs > 0
    ? clickMarkers.map((marker) => ({
        atMs: marker.atMs,
        durationMs: clickDurationMs,
      }))
    : []

  return {
    viewport: timelineReport?.video?.viewport || null,
    stepSegments,
    clickMarkers,
    clickHolds,
  }
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
      sourcePauseTimelineStepId: timing.sourcePauseTimelineStepId,
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

function toSyntheticStepId(index) {
  return `step-${index + 1}`
}

function resolveStepIdForTime(segments, timeMs) {
  const targetMs = Math.max(0, Number(timeMs) || 0)
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const startMs = Math.max(0, Math.round(Number(segment?.start || 0) * 1000))
    const endMs = Math.max(startMs + 1, Math.round(Number(segment?.end || 0) * 1000))
    if (targetMs >= startMs && targetMs < endMs) {
      return toSyntheticStepId(index)
    }
  }

  if (segments.length > 0 && targetMs >= Math.max(0, Math.round(Number(segments[segments.length - 1]?.end || 0) * 1000))) {
    return toSyntheticStepId(segments.length - 1)
  }

  return null
}

function buildSemanticContextFromVisualPlan({ visualRemotionPlan, title }) {
  const stepSegments = Array.isArray(visualRemotionPlan?.timeline?.stepSegments)
    ? visualRemotionPlan.timeline.stepSegments
    : []
  const chapterCurtains = Array.isArray(visualRemotionPlan?.timeline?.chapterCurtains)
    ? visualRemotionPlan.timeline.chapterCurtains
    : []
  const clickMarkers = Array.isArray(visualRemotionPlan?.timeline?.clickMarkers)
    ? visualRemotionPlan.timeline.clickMarkers
    : []

  const flow = []
  const timelineSteps = []
  for (let index = 0; index < stepSegments.length; index += 1) {
    const segment = stepSegments[index]
    const stepId = toSyntheticStepId(index)
    const startMs = Math.max(0, Math.round(Number(segment?.start || 0) * 1000))
    const endMs = Math.max(startMs + 1, Math.round(Number(segment?.end || 0) * 1000))
    flow.push({
      id: stepId,
      title: String(segment?.label || stepId),
    })
    timelineSteps.push({
      stepId,
      startedAtMs: startMs,
      endedAtMs: endMs,
    })
  }

  const chapterCards = chapterCurtains
    .map((entry, index) => {
      const atMs = Math.max(0, Math.round(Number(entry?.startSec || 0) * 1000))
      const endMs = Math.max(atMs + 1, Math.round(Number(entry?.endSec || 0) * 1000))
      const sourceScenarioStepId = resolveStepIdForTime(stepSegments, atMs)
      if (!sourceScenarioStepId) {
        return null
      }
      return {
        id: `${sourceScenarioStepId}-chapter-${index + 1}`,
        sourceScenarioStepId,
        title: String(entry?.text || '').trim() || `Chapter ${index + 1}`,
        text: String(entry?.text || '').trim() || `Chapter ${index + 1}`,
        atMs,
        durationMs: Math.max(1, endMs - atMs),
        fontSize: Math.max(1, Number(entry?.fontSize || 54)),
      }
    })
    .filter(Boolean)

  return {
    scenarioRoot: {
      id: 'annotated-video',
      title: String(title || 'Annotated Video').trim() || 'Annotated Video',
      flow,
    },
    timelineReport: {
      steps: timelineSteps,
      originalDurationMs: Math.max(1, Math.round(Number(visualRemotionPlan?.outputDurationSec || 0) * 1000)),
    },
    chapterCards,
    clickMarkers,
    stepSegments,
  }
}

function assignNarrationStepIds(narrations, segments) {
  const safeNarrations = Array.isArray(narrations) ? narrations : []
  const safeSegments = Array.isArray(segments) ? segments : []
  return safeNarrations.map((entry) => {
    const startMs = Math.max(0, Number(entry?.startMs || 0))
    const endMs = Math.max(startMs + 1, Number(entry?.endMs || (startMs + 1)))
    const midpointMs = startMs + ((endMs - startMs) / 2)
    const stepId = resolveStepIdForTime(safeSegments, midpointMs) || resolveStepIdForTime(safeSegments, startMs)
    if (!stepId) {
      return entry
    }
    return {
      ...entry,
      sourceScenarioStepId: stepId,
      sourceTimelineStepId: stepId,
      sourceAnchor: 'after',
    }
  })
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

async function resolveTtsEngineName() {
  if (buildAzureSpeechAuthContext() && resolveAzureSpeechEndpoint()) {
    return 'azure-speech-services'
  }
  throw new Error('Keine verfuegbare TTS-Engine gefunden. Bitte AZURE_SPEECHSERVICES_KEY oder AZURE_SPEECHSERVICES_TOKEN sowie AZURE_SPEECHSERVICES_ENDPOINT konfigurieren.')
}

function normalizeTtsVoiceName(voice) {
  return normalizeAzureTtsVoiceName(voice)
}

function getEffectiveTtsVoice({ narration, voiceOverride, engine }) {
  if (engine !== 'azure-speech-services') {
    throw new Error(`Nicht unterstuetzte TTS-Engine: ${engine}`)
  }
  return normalizeTtsVoiceName(voiceOverride || narration.voice || DEFAULT_AZURE_TTS_VOICE)
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

async function synthesizeWithAzureSpeech(narration, outPath, voiceOverride = null) {
  const authContext = buildAzureSpeechAuthContext()
  const endpoint = resolveAzureSpeechEndpoint()
  if (!authContext || !endpoint) {
    return false
  }

  const voice = normalizeTtsVoiceName(voiceOverride || narration.voice || DEFAULT_AZURE_TTS_VOICE)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...authContext.headers,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': DEFAULT_AZURE_TTS_OUTPUT_FORMAT,
      'User-Agent': 'lumiere-scenario-test-generator',
    },
    body: buildSharedAzureSpeechSsml({
      text: narration.text || '',
      ssml: narration.ssml || '',
      voice,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Azure Speech Services TTS fehlgeschlagen (${response.status} ${response.statusText}): ${errorBody || 'keine Fehlerdetails'}`)
  }

  const audioContent = new Uint8Array(await response.arrayBuffer())
  await writeFile(outPath, audioContent)
  return true
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
      if (engine !== 'azure-speech-services') {
        throw new Error(`Nicht unterstuetzte TTS-Engine: ${engine}`)
      }
      const synthesizedWithAzure = await synthesizeWithAzureSpeech(narration, outPath, voiceOverride)
      if (!synthesizedWithAzure) {
        throw new Error('Azure Speech Services wurde als Engine ausgewaehlt, konnte aber nicht ausgefuehrt werden.')
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

const mediaMetadataCache = new Map()

function getMediaMetadata(filePath) {
  const resolvedFilePath = resolve(String(filePath || ''))
  if (!resolvedFilePath) {
    throw new Error('Leerer Medienpfad uebergeben.')
  }

  const cached = mediaMetadataCache.get(resolvedFilePath)
  if (cached) {
    return cached
  }

  const script = [
    "import('@remotion/renderer')",
    '.then(async ({ getVideoMetadata }) => {',
    '  const meta = await getVideoMetadata(process.argv[1]);',
    '  const payload = {',
    '    durationInSeconds: Number(meta.durationInSeconds || 0),',
    '    width: Number(meta.width || 0),',
    '    height: Number(meta.height || 0),',
    '    fps: Number(meta.fps || 0),',
    '    hasAudio: Boolean(meta.audioCodec),',
    '  };',
    '  process.stdout.write(JSON.stringify(payload));',
    '})',
    '.catch((error) => {',
    '  process.stderr.write(String(error && error.message ? error.message : error));',
    '  process.exit(1);',
    '});',
  ].join('')

  let output = null
  try {
    output = runCommandWithOutput('node', ['-e', script, resolvedFilePath]).trim()
  } catch (err) {
    const errMsg = String(err?.message || '')
    if (errMsg.includes('No video stream found') || errMsg.includes('no video stream')) {
      // Audio-only file (e.g. MP3): fall back to ffprobe for duration
      const ffprobeOutput = runCommandWithOutput('ffprobe', [
        '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        resolvedFilePath,
      ]).trim()
      const durationInSeconds = Number(ffprobeOutput) || 0
      const fallback = { durationInSeconds, width: 0, height: 0, fps: 0, hasAudio: true }
      mediaMetadataCache.set(resolvedFilePath, fallback)
      return fallback
    }
    throw err
  }

  let parsed = null
  try {
    parsed = JSON.parse(output)
  } catch {
    parsed = null
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Konnte Medienmetadaten nicht lesen: ${resolvedFilePath}`)
  }

  mediaMetadataCache.set(resolvedFilePath, parsed)
  return parsed
}

function getMediaDurationSeconds(filePath) {
  const duration = Number(getMediaMetadata(filePath)?.durationInSeconds || 0)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Konnte Dauer nicht auslesen: ${filePath}`)
  }
  return duration
}

function getVideoDimensions(filePath) {
  const width = Number(getMediaMetadata(filePath)?.width || 0)
  const height = Number(getMediaMetadata(filePath)?.height || 0)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Konnte Video-Groesse nicht auslesen: ${filePath}`)
  }

  return { width, height }
}

function getVideoFps(filePath) {
  const fps = Number(getMediaMetadata(filePath)?.fps || 0)
  if (!Number.isFinite(fps) || fps <= 0) {
    return 30
  }
  return fps
}

function hasAudioStream(filePath) {
  return Boolean(getMediaMetadata(filePath)?.hasAudio)
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
  const resolvedInput = resolve(String(inputVideo || ''))
  const resolvedOutput = resolve(String(outputVideo || ''))
  if (!resolvedInput || !resolvedOutput || resolvedInput === resolvedOutput) {
    return
  }

  writeFileSync(resolvedOutput, readFileSync(resolvedInput))
}

function prependIntroToVideo({ inputVideo, outputVideo, introVideoPath = null, encodingConfig = null }) {
  const resolvedInput = resolve(String(inputVideo || ''))
  const resolvedOutput = resolve(String(outputVideo || ''))
  const resolvedIntro = resolve(String(introVideoPath || DEFAULT_VIDEO_INTRO_PATH))
  if (!resolvedInput || !resolvedOutput || resolvedInput === resolvedOutput) {
    return
  }

  if (!existsSync(resolvedInput)) {
    throw new Error(`Eingabevideo fuer Intro nicht gefunden: ${resolvedInput}`)
  }

  if (!existsSync(resolvedIntro)) {
    console.warn(`Intro-Video nicht gefunden, ueberspringe Intro: ${resolvedIntro}`)
    writeFileSync(resolvedOutput, readFileSync(resolvedInput))
    return
  }

  const introHasAudio = hasAudioStream(resolvedIntro)
  const mainHasAudio = hasAudioStream(resolvedInput)
  const introDurationSec = Math.max(0, Number(getMediaDurationSeconds(resolvedIntro) || 0))
  const mainDurationSec = Math.max(0, Number(getMediaDurationSeconds(resolvedInput) || 0))
  const targetSize = getVideoDimensions(resolvedInput)
  const normalizedEncoding = normalizeVideoEncodingConfig(encodingConfig)

  const args = [
    '-y',
    '-i', resolvedIntro,
    '-i', resolvedInput,
  ]

  const filterParts = [
    `[0:v]scale=${targetSize.width}:${targetSize.height}:force_original_aspect_ratio=decrease,pad=${targetSize.width}:${targetSize.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]`,
    `[1:v]scale=${targetSize.width}:${targetSize.height}:force_original_aspect_ratio=decrease,pad=${targetSize.width}:${targetSize.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]`,
    '[v0][v1]concat=n=2:v=1:a=0[v]',
  ]

  let hasOutputAudio = false
  if (introHasAudio && mainHasAudio) {
    filterParts.push('[0:a][1:a]concat=n=2:v=0:a=1[a]')
    hasOutputAudio = true
  } else if (introHasAudio && !mainHasAudio) {
    args.push('-f', 'lavfi', '-t', String(mainDurationSec), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    filterParts.push('[0:a][2:a]concat=n=2:v=0:a=1[a]')
    hasOutputAudio = true
  } else if (!introHasAudio && mainHasAudio) {
    args.push('-f', 'lavfi', '-t', String(introDurationSec), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    filterParts.push('[2:a][1:a]concat=n=2:v=0:a=1[a]')
    hasOutputAudio = true
  }

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[v]',
    '-c:v', 'libx264',
    '-preset', normalizedEncoding.preset,
    '-crf', String(normalizedEncoding.crf),
    '-pix_fmt', normalizedEncoding.pixFmt,
  )
  if (normalizedEncoding.videoBitrate) {
    args.push('-b:v', normalizedEncoding.videoBitrate)
  }

  if (hasOutputAudio) {
    args.push('-map', '[a]', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', normalizedEncoding.audioBitrate)
  }

  args.push('-movflags', '+faststart', resolvedOutput)

  const exitCode = runCommand('ffmpeg', args)
  if (exitCode !== 0) {
    throw new Error(`Intro-Video konnte nicht vorangestellt werden (Exit-Code ${exitCode}).`)
  }
}

function resolveVideoIntroConfig(videoScriptConfig) {
  const rawConfig = videoScriptConfig && typeof videoScriptConfig === 'object'
    ? videoScriptConfig
    : {}
  const introRaw = rawConfig.intro && typeof rawConfig.intro === 'object'
    ? rawConfig.intro
    : {}

  let enabled = true
  if (introRaw.enabled === false) {
    enabled = false
  }

  const configuredPath = String(
    introRaw.path
    || rawConfig.intro_video
    || rawConfig.introVideo
    || DEFAULT_VIDEO_INTRO_PATH
  ).trim()

  return {
    enabled,
    path: configuredPath ? resolve(configuredPath) : DEFAULT_VIDEO_INTRO_PATH,
  }
}

function resolveVideoPresentationConfig(videoScriptConfig) {
  const rawConfig = videoScriptConfig && typeof videoScriptConfig === 'object'
    ? videoScriptConfig
    : {}
  const stepTimingRaw = rawConfig?.presentation?.step_timing && typeof rawConfig.presentation.step_timing === 'object'
    ? rawConfig.presentation.step_timing
    : {}
  const slideRaw = rawConfig?.presentation?.slide && typeof rawConfig.presentation.slide === 'object'
    ? rawConfig.presentation.slide
    : {}

  return {
    stepTiming: {
      beforeInteractionMs: Math.max(0, Math.floor(Number(
        stepTimingRaw.before_interaction_ms
        ?? stepTimingRaw.beforeInteractionMs
        ?? 500,
      ) || 0)),
      afterInteractionMs: Math.max(0, Math.floor(Number(
        stepTimingRaw.after_interaction_ms
        ?? stepTimingRaw.afterInteractionMs
        ?? 500,
      ) || 0)),
    },
    slide: {
      defaultDurationMs: Math.max(1, Math.floor(Number(
        slideRaw.default_duration_ms
        ?? slideRaw.defaultDurationMs
        ?? 2000,
      ) || 2000)),
      inlineDefaultDurationMs: Math.max(1, Math.floor(Number(
        slideRaw.inline_default_duration_ms
        ?? slideRaw.inlineDefaultDurationMs
        ?? 3000,
      ) || 3000)),
    },
  }
}

function normalizeVideoEncodingConfig(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const preset = String(raw.preset || 'veryfast').trim() || 'veryfast'
  const pixFmt = String(raw.pix_fmt ?? raw.pixFmt ?? 'yuv420p').trim() || 'yuv420p'
  const crfValue = raw.crf == null ? 18 : Number(raw.crf)
  const videoBitrate = String(raw.video_bitrate ?? raw.videoBitrate ?? '').trim()
  const audioBitrate = String(raw.audio_bitrate ?? raw.audioBitrate ?? '192k').trim() || '192k'

  return {
    preset,
    crf: Number.isFinite(crfValue) ? Math.max(0, Math.floor(crfValue)) : 18,
    videoBitrate: videoBitrate || null,
    audioBitrate,
    pixFmt,
  }
}

function resolveVideoRenderConfig(videoScriptConfig) {
  const rawConfig = videoScriptConfig && typeof videoScriptConfig === 'object'
    ? videoScriptConfig
    : {}
  const renderRaw = rawConfig.render && typeof rawConfig.render === 'object'
    ? rawConfig.render
    : {}
  const fpsValue = renderRaw.fps == null ? null : Number(renderRaw.fps)

  return {
    fps: Number.isFinite(fpsValue) && fpsValue > 0 ? Math.max(1, Math.round(fpsValue)) : null,
    encoding: normalizeVideoEncodingConfig(renderRaw.encoding),
  }
}

function normalizeNarrationTimeline(audioFiles, narrationFreezeConfig = {}) {
  const adjustedAudioFiles = []
  const pauses = []
  let cumulativeShiftMs = 0
  const configuredBeforeMs = Math.max(0, Number(narrationFreezeConfig?.beforeMs || 0))
  const configuredAfterMs = Math.max(0, Number(narrationFreezeConfig?.afterMs || 0))

  for (const entry of audioFiles) {
    const audioDurationMs = Math.max(0, Math.round((entry.durationSec || 0) * 1000))
    const windowMs = Math.max(0, Math.round(entry.endMs - entry.startMs))
    const requiredDurationMs = configuredBeforeMs + audioDurationMs + configuredAfterMs
    const overflowMs = Math.max(0, requiredDurationMs - windowMs)
    const shiftBeforeMs = cumulativeShiftMs
    const shiftedStartMs = Math.max(0, Math.round(entry.startMs + cumulativeShiftMs))
    const shiftedWindowEndMs = Math.max(shiftedStartMs, Math.round(entry.endMs + shiftBeforeMs))
    const finalOutputStartMs = Math.max(shiftedStartMs, shiftedStartMs + configuredBeforeMs)
    const finalOutputEndMs = Math.max(finalOutputStartMs, finalOutputStartMs + audioDurationMs)

    adjustedAudioFiles.push({
      ...entry,
      windowMs,
      overflowMs,
      startMs: shiftedStartMs,
      shiftBeforeMs,
      audioDurationMs,
      configuredFreezeBeforeMs: configuredBeforeMs,
      configuredFreezeAfterMs: configuredAfterMs,
      shiftedWindowEndMs,
      pauseAtMs: null,
      finalOutputStartMs,
      finalOutputEndMs,
    })

    if (overflowMs > 0) {
      // Pause anchors for video holds must stay in source-video time space
      // because muxNarrationAudioIntoVideo trims [0:v] on original timestamps.
      const anchor = String(entry?.sourceAnchor || '').trim().toLowerCase()
      const pauseAtMs = anchor === 'before' || anchor === 'info-before' || anchor === 'info-presentation'
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

  const resolvedInput = resolve(String(inputVideo || ''))
  const resolvedOutput = resolve(String(outputVideo || ''))
  if (!resolvedInput || !resolvedOutput || resolvedInput === resolvedOutput) {
    return
  }

  writeFileSync(resolvedOutput, readFileSync(resolvedInput))
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

function readScenarioOutputIdentityFromXml(scenarioAbsolutePath) {
  if (!scenarioAbsolutePath || !existsSync(scenarioAbsolutePath)) {
    return null
  }

  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      trimValues: true,
    })
    const raw = readFileSync(scenarioAbsolutePath, 'utf8')
    const parsed = parser.parse(raw) || {}
    const root = parsed?.SzenarioScript || {}
    const fallbackToken = sanitizeFileToken(basename(scenarioAbsolutePath, extname(scenarioAbsolutePath)) || 'scenario')
    return {
      scenarioId: sanitizeFileToken(root['@_id'] || fallbackToken || 'scenario'),
      fallbackToken,
    }
  } catch {
    return null
  }
}

function resolveScenarioContextForTestFile(testFile) {
  const resolvedTestFile = resolve(testFile)
  const fallbackToken = sanitizeFileToken(basename(testFile).replace(/\.[^.]+$/, 'test'))
  const meta = readJsonSyncIfExists(`${resolvedTestFile}.meta.json`)
  const scenarioPathRelative = String(meta?.scenarioPathRelative || '').trim()
  if (!scenarioPathRelative) {
    return {
      scenarioFolderName: buildScenarioOutputFolderName({ scenarioId: fallbackToken, fallbackName: fallbackToken }),
      fallbackToken,
      scenarioPathRelative: null,
    }
  }

  const scenarioAbsolutePath = resolve(scenarioPathRelative)
  const identity = readScenarioOutputIdentityFromXml(scenarioAbsolutePath)
  const scenarioId = identity?.scenarioId || fallbackToken
  return {
    scenarioFolderName: buildScenarioOutputFolderName({ scenarioId, fallbackName: fallbackToken }),
    fallbackToken,
    scenarioPathRelative: normalizeWorkspaceRelativePath(scenarioPathRelative),
  }
}

function resolveExistingScenarioOutputRootFromPath(filePath) {
  if (!filePath) {
    return null
  }

  const outputRootAbsolute = resolve(OUTPUT_ROOT)
  const candidateAbsolute = resolve(filePath)
  const relativeToOutput = normalizeWorkspaceRelativePath(relative(outputRootAbsolute, candidateAbsolute))
  if (!relativeToOutput || relativeToOutput.startsWith('..')) {
    return null
  }

  const [scenarioFolderName] = relativeToOutput.split('/').filter(Boolean)
  if (!scenarioFolderName || scenarioFolderName === '_tts-cache') {
    return null
  }

  return join(outputRootAbsolute, scenarioFolderName)
}

function resolveVideoGeneratorRootForPaths(...paths) {
  for (const candidate of paths) {
    const scenarioOutputRoot = resolveExistingScenarioOutputRootFromPath(candidate)
    if (scenarioOutputRoot) {
      return join(scenarioOutputRoot, OUTPUT_VIDEOGENERATOR_SCOPE_DIR)
    }
  }
  return null
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

function buildFrameTimelineLog({ semanticVideoPlan, outputVideo }) {
  const fps = Math.max(1, Number(semanticVideoPlan?.source?.fps || 25))
  const lines = []
  let finalCursorMs = 0
  lines.push('# frame timeline log')
  lines.push(`outputVideo=${String(outputVideo || '')}`)
  lines.push(`fps=${fps}`)
  lines.push('')
  lines.push('formula: startFrame=floor(sourceStartMs/1000*fps), endFrameExcl=ceil(sourceEndMs/1000*fps)')
  lines.push('')
  lines.push('chapterId,stepId,sourceStartMs,sourceEndMs,sourceDurationSec,startFrame,endFrameExcl,durationFrames,holdDurationSec,finalStepDurationSec,finalVideoStartSec,finalVideoEndSec,pauseCount,clickMarkerCount')

  const chapters = Array.isArray(semanticVideoPlan?.chapters) ? semanticVideoPlan.chapters : []
  for (const chapter of chapters) {
    const chapterId = String(chapter?.id || '')
    const steps = Array.isArray(chapter?.steps) ? chapter.steps : []
    for (const step of steps) {
      const stepId = String(step?.id || '')
      const sourceStartMs = Math.max(0, Number(step?.clip?.sourceStartMs || 0))
      const sourceEndMs = Math.max(sourceStartMs + 1, Number(step?.clip?.sourceEndMs || (sourceStartMs + 1)))
      const sourceDurationMs = Math.max(1, sourceEndMs - sourceStartMs)
      const pauseDurationMs = (Array.isArray(step?.pauses) ? step.pauses : [])
        .reduce((sum, pause) => sum + Math.max(0, Number(pause?.durationMs || 0)), 0)
      const freezeDurationMs = (Array.isArray(step?.freezes) ? step.freezes : [])
        .reduce((sum, freeze) => sum + Math.max(0, Number(freeze?.durationMs || 0)), 0)
      const holdDurationMs = pauseDurationMs + freezeDurationMs
      const finalStepDurationMs = sourceDurationMs + holdDurationMs
      const finalVideoStartMs = finalCursorMs
      const finalVideoEndMs = finalVideoStartMs + finalStepDurationMs
      const startFrame = Math.max(0, Math.floor((sourceStartMs / 1000) * fps))
      const endFrameExcl = Math.max(1, Math.ceil((sourceEndMs / 1000) * fps))
      const durationFrames = Math.max(1, endFrameExcl - startFrame)
      const pauseCount = Array.isArray(step?.pauses) ? step.pauses.length : 0
      const clickMarkerCount = Array.isArray(step?.clickMarkers) ? step.clickMarkers.length : 0
      lines.push([
        chapterId,
        stepId,
        String(Math.floor(sourceStartMs)),
        String(Math.floor(sourceEndMs)),
        (sourceDurationMs / 1000).toFixed(3),
        String(startFrame),
        String(endFrameExcl),
        String(durationFrames),
        (holdDurationMs / 1000).toFixed(3),
        (finalStepDurationMs / 1000).toFixed(3),
        (finalVideoStartMs / 1000).toFixed(3),
        (finalVideoEndMs / 1000).toFixed(3),
        String(pauseCount),
        String(clickMarkerCount),
      ].join(','))
      finalCursorMs = finalVideoEndMs
    }
  }

  return `${lines.join('\n')}\n`
}

function writeSemanticRemotionArtifacts({ inputVideo, outputVideo, adjustedAudioFiles, semanticContext, render = true }) {
  const debugOverlayEnabled = ['1', 'true', 'yes', 'on']
    .includes(String(process.env.LUMIERE_VIDEO_DEBUG_OVERLAY || '').trim().toLowerCase())
  const renderPlanPath = `${outputVideo}.remotion-render-plan.json`
  const semanticVideoPlanPath = `${outputVideo}.semantic-video-plan.json`
  const renderScriptTsxPath = `${outputVideo}.semantic.tsx`
  const runtimeScriptSnapshotPath = `${outputVideo}.runtime.tsx`
  const finalRemotionDocumentPath = renderScriptTsxPath
  const frameTimelineLogPath = `${outputVideo}.frame-timeline.log`
  const widthHeight = getVideoDimensions(inputVideo)
  const configuredFps = Number(semanticContext?.videoRenderConfig?.fps || 0)
  const fps = Number.isFinite(configuredFps) && configuredFps > 0
    ? Math.max(1, Math.round(configuredFps))
    : getVideoFps(inputVideo)
  const semanticRuntimePath = resolve('scripts/video-script-generator/runtime/semantic-runtime.tsx')
  const introConfig = semanticContext?.videoIntroConfig && typeof semanticContext.videoIntroConfig === 'object'
    ? semanticContext.videoIntroConfig
    : null
  const introPathCandidate = introConfig?.enabled === false ? null : String(introConfig?.path || '').trim()
  const introPathResolved = introPathCandidate ? resolve(introPathCandidate) : null
  const introDurationMs = introPathResolved && existsSync(introPathResolved)
    ? Math.max(0, Math.floor(Number(getMediaDurationSeconds(introPathResolved) || 0) * 1000))
    : 0
  const videoIntro = introPathResolved && introDurationMs > 0
    ? { path: introPathResolved, durationMs: introDurationMs }
    : null

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
    stepTiming: semanticContext?.videoPresentationConfig?.stepTiming || null,
    slideDefaults: semanticContext?.videoPresentationConfig?.slide || null,
    videoIntro,
  })
  const renderPlan = buildRemotionRenderPlan({
    semanticPlan: semanticVideoPlan,
    outputVideo,
    adjustedAudioFiles,
    renderConfig: semanticContext?.videoRenderConfig || null,
  })
  const renderScriptTsx = buildSemanticRemotionTsx({
    semanticPlan: semanticVideoPlan,
    outputFilePath: renderScriptTsxPath,
    runtimeFilePath: semanticRuntimePath,
    debugOverlay: debugOverlayEnabled,
  })

  writeFileSync(renderPlanPath, JSON.stringify(renderPlan, null, 2), 'utf8')
  writeFileSync(semanticVideoPlanPath, JSON.stringify(semanticVideoPlan, null, 2), 'utf8')
  writeFileSync(renderScriptTsxPath, renderScriptTsx, 'utf8')
  writeFileSync(runtimeScriptSnapshotPath, readFileSync(semanticRuntimePath, 'utf8'), 'utf8')
  writeFileSync(frameTimelineLogPath, buildFrameTimelineLog({ semanticVideoPlan, outputVideo }), 'utf8')

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
    semanticVideoPlanPath,
    renderScriptTsxPath,
    runtimeScriptSnapshotPath,
    finalRemotionDocumentPath,
    frameTimelineLogPath,
  }
}

function muxNarrationAudioIntoVideo({ inputVideo, outputVideo, audioFiles, semanticContext = null, render = true, narrationFreezeConfig = null }) {
  const videoDurationSec = getMediaDurationSeconds(inputVideo)
  const audioWithDuration = audioFiles.map((entry) => ({
    ...entry,
    durationSec: Number.isFinite(Number(entry?.durationSec)) && Number(entry.durationSec) > 0
      ? Number(entry.durationSec)
      : getMediaDurationSeconds(entry.file),
  }))
  const { adjustedAudioFiles, pauses, totalHoldMs } = normalizeNarrationTimeline(audioWithDuration, narrationFreezeConfig || {})
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
  let remotionRuntimeScriptTsxPath = null
  let finalRemotionDocumentPath = null
  let frameTimelineLogPath = null

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
  remotionRuntimeScriptTsxPath = remotionArtifacts.runtimeScriptSnapshotPath
  finalRemotionDocumentPath = remotionArtifacts.finalRemotionDocumentPath
  frameTimelineLogPath = remotionArtifacts.frameTimelineLogPath

  return {
    adjustedAudioFiles,
    pauses,
    totalHoldMs,
    outputDurationSec,
    remotionRenderPlanPath,
    remotionSemanticPlanPath,
    remotionRenderScriptTsxPath,
    remotionRuntimeScriptTsxPath,
    finalRemotionDocumentPath,
    frameTimelineLogPath,
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
  const { scenarioFolderName, fallbackToken } = resolveScenarioContextForTestFile(testFile)
  const testRunsRoot = join(OUTPUT_ROOT, scenarioFolderName, OUTPUT_VIDEOGENERATOR_SCOPE_DIR)
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
    const defaultVideo = join(finalDir, `${fallbackToken}-annotated-${runId}.mp4`)
    const previousOutputVideo = existsSync(defaultVideo)
      ? defaultVideo
      : join(finalDir, `${fallbackToken}-annotated.mp4`)

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
  videoIntroConfig = { enabled: true, path: DEFAULT_VIDEO_INTRO_PATH },
  videoRenderConfig = { fps: null, encoding: { preset: 'veryfast', crf: 18, videoBitrate: null, audioBitrate: '192k', pixFmt: 'yuv420p' } },
  videoPresentationConfig = { stepTiming: { beforeInteractionMs: 500, afterInteractionMs: 500 }, slide: { defaultDurationMs: 2000, inlineDefaultDurationMs: 3000 } },
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
    '--skip-remotion-script',
    '--plan-only',
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
  const visualRemotionPlan = await readJsonIfExists(annotateMeta?.remotionPlanPath)
  if (!visualRemotionPlan) {
    throw new Error('Annotate-Plan fehlt: remotionPlanPath konnte nicht geladen werden.')
  }

  const videoTitle = await resolveVideoTitleFromDemoDir(resolvedDemoDir)
  const semanticContext = buildSemanticContextFromVisualPlan({
    visualRemotionPlan,
    title: videoTitle,
  })

  muxNarrationAudioIntoVideo({
    inputVideo: resolvedInputVideo,
    outputVideo: introlessOutputVideo,
    audioFiles: [],
    semanticContext: {
      ...semanticContext,
      videoIntroConfig,
      videoRenderConfig,
      videoPresentationConfig,
    },
    render: true,
  })

  await copyFile(introlessOutputVideo, resolvedOutputVideo)

  if (tts) {
    const combinedHolds = [...(annotateMeta.clickHolds || [])]

    console.log('Verarbeite Demo-Timeline fuer TTS...')
    const resolvedNarrations = await resolveNarrationsFromDemoDir(resolvedDemoDir, {
      clickHolds: combinedHolds,
    })
    const narrationsWithStepIds = assignNarrationStepIds(
      resolvedNarrations,
      semanticContext.stepSegments,
    )
    if (resolvedNarrations.length === 0) {
      throw new Error('TTS angefordert, aber keine Narrationsdefinitionen gefunden.')
    }

    const { audioFiles, engine, cacheHits, cacheMisses, cacheDir } = await synthesizeNarrations(resolvedDemoDir, narrationsWithStepIds, ttsVoice)
    console.log(`TTS-Engine: ${engine}. Narrationsdateien: ${audioFiles.length}. Cache: ${cacheHits} Treffer, ${cacheMisses} neu erzeugt (${cacheDir})`)

    const timedAudioFiles = applyNarrationTimingToAudioFiles(audioFiles, narrationsWithStepIds)

    const outputWithTts = outputPathWithSuffix(resolvedOutputVideo, '-tts')
    const outputWithTtsRaw = outputPathWithSuffix(outputWithTts, '-raw')
    console.log('Mische Voiceover in das annotierte Video...')
    muxNarrationAudioIntoVideo({
      inputVideo: resolvedInputVideo,
      outputVideo: outputWithTtsRaw,
      audioFiles: timedAudioFiles,
      semanticContext: {
        ...semanticContext,
        videoIntroConfig,
        videoRenderConfig,
        videoPresentationConfig,
      },
      render: true,
    })
    await copyFile(outputWithTtsRaw, outputWithTts)
    console.log(`Voiceover-Video bereit: ${outputWithTts}`)
  }

  console.log(`\nAnnotiertes Video bereit: ${resolvedOutputVideo}`)
}

function sanitizeFileToken(value) {
  return sanitizeScenarioOutputToken(value, 'output')
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

async function copyArtifactIfExists(sourcePath, targetPath) {
  if (!sourcePath || !existsSync(sourcePath)) {
    return false
  }
  await mkdir(dirname(targetPath), { recursive: true })
  await copyFile(sourcePath, targetPath)
  return true
}

async function exportScenarioTtsDebugArtifacts({
  ttsOutputDir,
  profileToken,
  runId,
  scenarioAbsolutePath,
  resolvedXmlPath,
  resolvedJsonPath,
  muxMeta,
}) {
  const debugDir = join(ttsOutputDir, `scenario-tts-debug-artifacts-${profileToken}-${runId}`)
  await mkdir(debugDir, { recursive: true })

  await copyArtifactIfExists(SCENARIO_SCRIPT_XSD_PATH, join(debugDir, 'szenarioscript.xsd'))
  await copyArtifactIfExists(SEMANTIC_VIDEO_PLAN_SCHEMA_PATH, join(debugDir, 'lumiere-semantic-video-plan.schema.json'))
  await copyArtifactIfExists(scenarioAbsolutePath, join(debugDir, basename(String(scenarioAbsolutePath || 'scenario.xml'))))
  await copyArtifactIfExists(resolvedXmlPath, join(debugDir, basename(String(resolvedXmlPath || 'scenario.test-resolved.xml'))))
  await copyArtifactIfExists(resolvedJsonPath, join(debugDir, basename(String(resolvedJsonPath || 'scenario.resolved.json'))))
  await copyArtifactIfExists(muxMeta?.remotionRenderPlanPath, join(debugDir, 'remotion-render-plan.json'))
  await copyArtifactIfExists(muxMeta?.remotionSemanticPlanPath, join(debugDir, 'remotion-semantic-video-plan.json'))
  await copyArtifactIfExists(muxMeta?.remotionRenderScriptTsxPath, join(debugDir, 'remotion-semantic.tsx'))
  await copyArtifactIfExists(muxMeta?.remotionRuntimeScriptTsxPath, join(debugDir, 'remotion-runtime.tsx'))
  await copyArtifactIfExists(muxMeta?.finalRemotionDocumentPath, join(debugDir, 'final-remotion-document.tsx'))
  await copyArtifactIfExists(muxMeta?.frameTimelineLogPath, join(debugDir, 'frame-timeline.log'))

  return debugDir
}

async function runScenarioTtsMode({ scenarioPath, scenarioId, scenarioVersion: scenarioVersionOverride = null, fragmentSource = 'local', profileName, outputVideo, ttsVoice = null, remotionPlanOnly = false, software = null }) {
  const central = loadCentralConfig(process.cwd(), { software })
  const videoScriptConfig = getVideoScriptConfig(central.config)
  const videoIntroConfig = resolveVideoIntroConfig(videoScriptConfig)
  const videoRenderConfig = resolveVideoRenderConfig(videoScriptConfig)
  const videoPresentationConfig = resolveVideoPresentationConfig(videoScriptConfig)
  const scenarioAbsolutePath = resolve(scenarioPath)
  if (!existsSync(scenarioAbsolutePath)) {
    throw new Error(`Szenario-Datei nicht gefunden: ${scenarioPath}`)
  }

  if (extname(scenarioAbsolutePath).toLowerCase() !== '.xml') {
    throw new Error('Im Modus --scenario-tts werden nur XML-Szenarien unterstuetzt.')
  }
  const scenarioIdOverride = sanitizeFileToken(scenarioId, '')
  if (!scenarioIdOverride) {
    throw new Error('Im Modus --scenario-tts wird --scenario-id=<id> erwartet.')
  }

  const scenarioPathRelative = normalizeWorkspaceRelativePath(scenarioPath)
  const profile = resolveScenarioTtsProfile(videoScriptConfig, profileName)
  const narrationFreezeConfig = resolveNarrationFreezeConfig(profile)

  const { scenarioRoot, resolvedJsonPath, resolvedXmlPath, videoScriptRange } = await loadScenarioRootForTts(scenarioAbsolutePath, {
    fragmentSource,
  })
  const scenarioVersion = String(scenarioVersionOverride || '').trim() || 'unknown'

  const artifacts = await ensureScenarioVideoTimelinePair({
    scenarioId: scenarioIdOverride,
    scenarioVersion,
    scenarioPathRelative,
  })

  if (remotionPlanOnly) {
    console.warn('[scenario-tts] remotion-plan-only: Verwende vorhandenes Rohvideo ohne strikte Szenario-vs-Rohvideo-Validierung.')
  }

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
  const scenarioOutputRoot = buildScenarioOutputRoot(process.cwd(), scenarioIdOverride, scenarioToken)
  const ttsOutputDir = join(scenarioOutputRoot, OUTPUT_VIDEOGENERATOR_SCOPE_DIR)
  const canonicalOutputFilename = buildCanonicalScenarioVideoFilename({
    scenarioId: scenarioIdOverride,
    scenarioVersion,
  })
  const resolvedOutputVideo = outputVideo
    ? resolve(outputVideo)
    : join(ttsOutputDir, canonicalOutputFilename)

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
          const sourceTimelineStepId = String(entry.sourceTimelineStepId || '').trim()
          const sourceAnchor = String(entry.sourceAnchor || '').trim()
          const shouldKeepBoundaryBeforeNarration = Boolean(
            clipStartMs > 0
            && startDirectiveStepId
            && (sourceAnchor === 'before' || sourceAnchor === 'info-before')
            && (sourceScenarioStepId === startDirectiveStepId || sourceTimelineStepId === startDirectiveStepId),
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

  const clickIndicatorConfig = resolveScenarioClickIndicatorConfig(scenarioRoot, videoScriptConfig)

  const sourceVideoForTts = artifacts.videoPath
  const visualTimeline = buildVisualTimelineFromScenarioTimeline({
    timelineReport: artifacts.timeline,
    clickIndicatorConfig,
  })
  const sourceVideoDimensions = getVideoDimensions(sourceVideoForTts)

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

  let clickHolds = Array.isArray(visualTimeline.clickHolds) ? visualTimeline.clickHolds : []
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
  let finalChapterTitlesForNarration = chapterTitlesForNarration

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
    if (remotionPlanOnly) {
      return {
        audioFiles: [],
        engine: 'none-plan-only',
        cacheHits: 0,
        cacheMisses: 0,
        cacheDir: DEMO_TTS_CACHE_DIR,
      }
    }

    if (synthesizedNarrations || !effectiveNarrations.length) {
      return synthesizedNarrations
    }

    synthesizedNarrations = await synthesizeNarrations(artifacts.dir, effectiveNarrations, ttsVoice)
    console.log(`TTS-Engine: ${synthesizedNarrations.engine}. Narrationsdateien: ${synthesizedNarrations.audioFiles.length}. Cache: ${synthesizedNarrations.cacheHits} Treffer, ${synthesizedNarrations.cacheMisses} neu erzeugt (${synthesizedNarrations.cacheDir})`)
    return synthesizedNarrations
  }

  let resolvedChapterCards = chapterTitlesForOverlays
  const hasAutoDurationChapter = chapterTitlesForNarration.some((entry) => !entry.hasExplicitDuration)
  if (!remotionPlanOnly && hasAutoDurationChapter && chapterNarrations.length > 0 && effectiveNarrations.length > 0) {
    const synthesized = await ensureSynthesizedNarrations()
    const resolvedChapterTitlesForNarration = resolveChapterDurationsFromSynthesizedAudio({
      chapterTitles: chapterTitlesForNarration,
      chapterNarrations,
      audioFiles: synthesized?.audioFiles || [],
    })
    finalChapterTitlesForNarration = resolvedChapterTitlesForNarration

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

  const chapterEndByScenarioStepId = new Map(
    (Array.isArray(finalChapterTitlesForNarration) ? finalChapterTitlesForNarration : [])
      .map((entry) => {
        const scenarioStepId = String(entry?.sourceScenarioStepId || '').trim()
        if (!scenarioStepId) {
          return null
        }
        const chapterStartMs = Math.max(0, Number(entry?.atMs) || 0)
        const chapterDurationMs = Math.max(1, Number(entry?.durationMs) || 1)
        return [scenarioStepId, Math.max(chapterStartMs, chapterStartMs + chapterDurationMs)]
      })
      .filter(Boolean)
  )

  if (chapterEndByScenarioStepId.size > 0) {
    effectiveNarrations = effectiveNarrations.map((entry) => {
      const anchor = String(entry?.sourceAnchor || '').trim().toLowerCase()
      if (anchor !== 'info-before') {
        return entry
      }

      const scenarioStepId = String(entry?.sourceScenarioStepId || '').trim()
      const chapterEndMs = Number(chapterEndByScenarioStepId.get(scenarioStepId))
      if (!scenarioStepId || !Number.isFinite(chapterEndMs)) {
        return entry
      }

      const startMs = Math.max(0, Number(entry?.startMs) || 0)
      if (chapterEndMs <= startMs) {
        return entry
      }

      const endMs = Math.max(startMs + 1, Number(entry?.endMs) || (startMs + 1))
      const deltaMs = Math.max(0, chapterEndMs - startMs)
      return {
        ...entry,
        startMs: startMs + deltaMs,
        endMs: endMs + deltaMs,
      }
    })
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
  } else if (remotionPlanOnly) {
    console.log('[scenario-tts] remotion-plan-only aktiv: TTS-Synthese wird uebersprungen, Narrationsdauer wird aus Zeitfenstern geschaetzt.')
    audioFiles = effectiveNarrations.map((entry) => {
      const startMs = Math.max(0, Number(entry?.startMs) || 0)
      const endMs = Math.max(startMs + 1, Number(entry?.endMs) || (startMs + 1))
      const durationSec = Math.max(0.001, (endMs - startMs) / 1000)
      return {
        ...entry,
        file: null,
        durationSec,
      }
    })
  } else {
    const synthesized = await ensureSynthesizedNarrations()
    audioFiles = applyNarrationTimingToAudioFiles(synthesized.audioFiles, effectiveNarrations)
  }

  const timelineOriginMs = resolveTimelineOriginMs(artifacts.timeline)
  const clipStartMs = presentationRange
    ? Math.max(0, Number(presentationRange.startMs) || 0)
    : 0
  const clipEndMs = presentationRange?.endMs == null
    ? null
    : Math.max(clipStartMs, Number(presentationRange.endMs) || clipStartMs)

  const visualOverlays = {
    stepSegments: Array.isArray(visualTimeline.stepSegments)
      ? visualTimeline.stepSegments.map((segment) => {
          const absoluteStartMs = Math.max(0, Number(segment?.startMs || 0))
          const absoluteEndMs = Math.max(absoluteStartMs + 1, Number(segment?.endMs || (absoluteStartMs + 1)))
          const sourceRelativeStartMs = Math.max(0, absoluteStartMs - timelineOriginMs)
          const sourceRelativeEndMs = Math.max(sourceRelativeStartMs + 1, absoluteEndMs - timelineOriginMs)
          const clippedStartMs = Math.max(sourceRelativeStartMs, clipStartMs)
          const clippedEndMs = clipEndMs == null
            ? sourceRelativeEndMs
            : Math.min(sourceRelativeEndMs, clipEndMs)
          if (clippedEndMs <= clippedStartMs) {
            return null
          }
          return {
            stepId: String(segment?.stepId || '').trim() || undefined,
            label: String(segment?.label || ''),
            interactionType: segment?.interactionType == null ? undefined : String(segment.interactionType),
            start: clippedStartMs / 1000,
            end: clippedEndMs / 1000,
          }
        }).filter(Boolean)
      : [],
    clickMarkers: Array.isArray(visualTimeline.clickMarkers)
      ? (() => {
          return visualTimeline.clickMarkers.map((marker) => {
            const absoluteAtMs = Math.max(0, Number(marker?.atMs || 0))
            const sourceRelativeAtMs = Math.max(0, absoluteAtMs - timelineOriginMs)
            if (sourceRelativeAtMs < clipStartMs || (clipEndMs != null && sourceRelativeAtMs > clipEndMs)) {
              return null
            }
            const scaledPoint = scaleTimelinePointToVideo({
              x: marker?.x,
              y: marker?.y,
              viewport: visualTimeline.viewport,
              videoDimensions: sourceVideoDimensions,
            })
            return {
              stepId: String(marker?.stepId || '').trim() || undefined,
              x: scaledPoint.x,
              y: scaledPoint.y,
              at: sourceRelativeAtMs / 1000,
              durationMs: Math.max(1, Math.floor((Number(clickIndicatorConfig?.beforeMs || 0) + Number(clickIndicatorConfig?.afterMs || 0)) || 900)),
            }
          }).filter(Boolean)
        })()
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
      videoIntroConfig,
      videoRenderConfig,
      videoPresentationConfig,
    },
    narrationFreezeConfig,
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
    const persistentArtifactsDir = buildPersistentScenarioArtifactsRoot(process.cwd(), scenarioIdOverride, scenarioVersion, 'videoscript')
    const persistentOutputVideo = join(persistentArtifactsDir, 'final', buildCanonicalScenarioVideoFilename({
      scenarioId: scenarioIdOverride,
      scenarioVersion,
    }))
    await writeFile(remotionMuxMetaPath, JSON.stringify({
      planOnly: remotionPlanOnly ? true : undefined,
      renderPlanPath: muxMeta?.remotionRenderPlanPath || null,
      semanticVideoPlanPath: muxMeta?.remotionSemanticPlanPath || null,
      renderTsxPath: muxMeta?.remotionRenderScriptTsxPath || null,
      runtimeTsxPath: muxMeta?.remotionRuntimeScriptTsxPath || null,
      finalRemotionDocumentPath: muxMeta?.finalRemotionDocumentPath || null,
      frameTimelineLogPath: muxMeta?.frameTimelineLogPath || null,
      outputVideo: resolvedOutputVideo,
      persistentArtifactsDir,
      persistentOutputVideo,
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

  const debugArtifactsDir = await exportScenarioTtsDebugArtifacts({
    ttsOutputDir,
    profileToken,
    runId,
    scenarioAbsolutePath,
    resolvedXmlPath,
    resolvedJsonPath,
    muxMeta,
  })

  console.log(`Aufgeloeste Narrations-Timeline: ${resolvedTimelinePath}`)
  console.log(`TTS-Diagnose-Log: ${diagnosticsLogPath}`)
  console.log(`Debug-Artefakte (Schema + Remotion): ${debugArtifactsDir}`)
  if (remotionPlanOnly) {
    console.log(`Plan-Modus: Render wurde uebersprungen, kanonisches Kompositionsmodell wurde erstellt.`)
    console.log(`Render-Zielvideo (noch nicht erzeugt): ${resolvedOutputVideo}`)
    return
  }

  const persistentArtifacts = await persistStableScenarioVideoArtifact({
    scenarioId: scenarioIdOverride,
    scenarioVersion,
    outputVideo: resolvedOutputVideo,
  })

  console.log(`Profil-Voiceover-Video bereit: ${resolvedOutputVideo}`)
  console.log(`Persistentes Finalvideo: ${persistentArtifacts.outputVideoRelative}`)
}

async function persistStableScenarioVideoArtifact({ scenarioId, scenarioVersion, outputVideo }) {
  const normalizedVersion = buildScenarioArtifactVersionToken(scenarioVersion)
  const persistentRoot = buildPersistentScenarioArtifactsRoot(process.cwd(), scenarioId, normalizedVersion, 'videoscript')
  const targetVideoPath = join(persistentRoot, 'final', buildCanonicalScenarioVideoFilename({
    scenarioId,
    scenarioVersion: normalizedVersion,
  }))

  await rm(persistentRoot, { recursive: true, force: true })
  await mkdir(dirname(targetVideoPath), { recursive: true })
  await copyFile(outputVideo, targetVideoPath)
  await writeFile(join(persistentRoot, 'export-meta.json'), JSON.stringify({
    createdAtIso: new Date().toISOString(),
    scenarioId,
    scenarioVersion: normalizedVersion,
    generatorType: 'videoscript',
    outputVideoRelative: normalizeWorkspaceRelativePath(relative(process.cwd(), targetVideoPath)),
    sourceOutputVideoRelative: normalizeWorkspaceRelativePath(relative(process.cwd(), outputVideo)),
  }, null, 2), 'utf8')

  return {
    rootRelative: normalizeWorkspaceRelativePath(relative(process.cwd(), persistentRoot)),
    outputVideoRelative: normalizeWorkspaceRelativePath(relative(process.cwd(), targetVideoPath)),
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const central = loadCentralConfig(process.cwd(), { software: parsed.software })
  const videoScriptConfig = getVideoScriptConfig(central.config)
  const videoIntroConfig = resolveVideoIntroConfig(videoScriptConfig)
  const videoRenderConfig = resolveVideoRenderConfig(videoScriptConfig)
  const videoPresentationConfig = resolveVideoPresentationConfig(videoScriptConfig)
  if (parsed.help) {
    printUsage()
    return
  }

  if (parsed.scenarioTts) {
    await runScenarioTtsMode({
      scenarioPath: parsed.scenarioPath,
      scenarioId: parsed.scenarioId,
      scenarioVersion: parsed.scenarioVersion,
      software: parsed.software,
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
      videoIntroConfig,
      videoRenderConfig,
      videoPresentationConfig,
    })
    return
  }

  if (parsed.annotateOnly) {
    const runId = toRunId()
    const annotateToken = sanitizeFileToken(basename(parsed.inputVideo).replace(/\.[^.]+$/, 'video'))
    const annotateRunsRoot = resolveVideoGeneratorRootForPaths(parsed.inputVideo, parsed.demoDir, parsed.tracePath)
      || buildVideoGeneratorRoot(annotateToken)
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
      videoIntroConfig,
      videoRenderConfig,
      videoPresentationConfig,
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
      : outputPathWithSuffix(
        join(
          resolveVideoGeneratorRootForPaths(parsed.inputVideo, parsed.demoDir) || buildVideoGeneratorRoot(sanitizeFileToken(basename(parsed.inputVideo).replace(/\.[^.]+$/, 'video'))),
          basename(resolvedInputVideo),
        ),
        '-tts',
      )
    console.log('Mische Voiceover in das annotierte Video...')
    await mkdir(dirname(outputWithTts), { recursive: true })
    muxNarrationAudioIntoVideo({
      inputVideo: resolvedInputVideo,
      outputVideo: outputWithTts,
      audioFiles,
      semanticContext: {
        videoRenderConfig,
      },
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
  const { scenarioFolderName, fallbackToken: testToken } = resolveScenarioContextForTestFile(testFile)
  const runRootDir = join(OUTPUT_ROOT, scenarioFolderName, OUTPUT_VIDEOGENERATOR_SCOPE_DIR, runId)
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
      videoIntroConfig,
      videoPresentationConfig,
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
