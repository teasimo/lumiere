#!/usr/bin/env node

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, extname, join, relative, resolve } from 'path'
import { spawn } from 'child_process'
import { Buffer } from 'buffer'
import { hostname } from 'os'
import { XMLParser } from 'fast-xml-parser'
import {
  getTestScriptConfig,
  getVideoScriptConfig,
  loadCentralConfig,
} from '../shared/central-config.mjs'
import {
  buildScenarioOutputFolderName,
  sanitizeScenarioOutputToken,
} from '../shared/scenario-output.mjs'
import { appendFragmentSourceArg } from '../shared/lunettes-fragment-source.mjs'

const workspaceRoot = process.cwd()
const runtimeRoot = resolve(workspaceRoot, 'temp', 'lunettes-job-watcher')
const jobsRoot = join(runtimeRoot, 'jobs')
const scenarioCacheRoot = resolve(workspaceRoot, 'neo', 'interactions', '_lunettes-job-watcher')
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
})
const allowedTypes = new Set(['testscript', 'videoscript', 'publish'])
const allowedTestModes = new Set(['check', 'video'])
const tailLimitChars = 12000
const jobEventLogBatchSize = 5
const jobEventLogLineMaxLength = 800
const jobEventLogFlushIntervalMs = 60000
const scriptInactivityTimeoutMs = 180000
const scriptTerminationGracePeriodMs = 60000

class JobCanceledError extends Error {
  constructor(message = 'Job wurde serverseitig abgebrochen.') {
    super(message)
    this.name = 'JobCanceledError'
  }
}

function printUsage() {
  console.log(`Usage:
  node lunettes-job-watcher/watch-lunettes-jobs.mjs [--once] [--types=testscript,videoscript,publish] [--worker-id=<id>] [--lease-seconds=<sec>] [--poll-interval-ms=<ms>]

Environment:
  LUNETTES_API_USERNAME
  LUNETTES_API_PASSWORD
  LUNETTES_JOB_WORKER_ID (optional)

Config:
  scenario.config.json > scenario["lunettes-job-watcher"] can override:
    - base_url
    - types
    - worker_id
    - lease_seconds
    - poll_interval_ms
    - testscript_mode
    - video_profile
`)
}

function parseArgs(argv) {
  const options = {
    once: false,
    types: null,
    workerId: null,
    leaseSeconds: null,
    pollIntervalMs: null,
    baseUrl: null,
  }

  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      options.help = true
      return options
    }

    if (token === '--once') {
      options.once = true
      continue
    }

    if (token.startsWith('--types=')) {
      options.types = token.slice('--types='.length)
      continue
    }

    if (token.startsWith('--worker-id=')) {
      options.workerId = token.slice('--worker-id='.length)
      continue
    }

    if (token.startsWith('--lease-seconds=')) {
      options.leaseSeconds = token.slice('--lease-seconds='.length)
      continue
    }

    if (token.startsWith('--poll-interval-ms=')) {
      options.pollIntervalMs = token.slice('--poll-interval-ms='.length)
      continue
    }

    if (token.startsWith('--base-url=')) {
      options.baseUrl = token.slice('--base-url='.length)
      continue
    }

    throw new Error(`Unknown option: ${token}`)
  }

  return options
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function buildBasicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function normalizeTypes(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)

  const types = rawValues
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => allowedTypes.has(entry))

  return types.length > 0 ? [...new Set(types)] : ['testscript', 'videoscript', 'publish']
}

function sanitizeFileToken(value, fallback = 'scenario') {
  return sanitizeScenarioOutputToken(value, fallback)
}

function toWorkspaceRelativePath(pathValue) {
  return String(relative(workspaceRoot, resolve(pathValue))).replace(/\\/g, '/')
}

function truncateText(value, maxLength = 500) {
  const text = String(value || '').trim()
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

function splitCompleteLines(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parts = normalized.split('\n')
  const trailing = normalized.endsWith('\n') ? '' : (parts.pop() ?? '')
  const completeLines = parts.filter((line) => line.length > 0)
  return {
    completeLines,
    trailing,
  }
}

function isJobCanceledConflict(error) {
  return Number(error?.statusCode) === 409
    && String(error?.responsePayload?.code || '').trim().toLowerCase() === 'job_canceled'
}

function parseScenarioIdentityFromXml(xmlRaw, fallbackScenarioId) {
  const parsed = xmlParser.parse(xmlRaw) || {}
  const root = parsed?.SzenarioScript
  if (!root || typeof root !== 'object') {
    throw new Error('Ungueltiges Szenario-XML: <SzenarioScript> fehlt.')
  }

  const scenarioId = sanitizeFileToken(root['@_id'] || fallbackScenarioId, fallbackScenarioId)
  const scenarioVersion = String(root['@_szenario-version'] || '').trim() || 'unknown'
  const title = String(root['@_titel'] || '').trim()

  return {
    scenarioId,
    scenarioVersion,
    title,
  }
}

async function fetchJson(url, { method = 'GET', authHeader, body = undefined } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  })

  const rawText = await response.text()
  let payload = null
  try {
    payload = rawText ? JSON.parse(rawText) : null
  } catch {
    payload = rawText || null
  }

  if (!response.ok) {
    const details = payload == null ? '' : ` Response: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`
    const error = new Error(`HTTP ${response.status} ${response.statusText} for ${method} ${url}.${details}`)
    error.statusCode = response.status
    error.responsePayload = payload
    error.url = url
    error.method = method
    throw error
  }

  return payload
}

async function postJobEvent(context, jobId, {
  eventType,
  message,
  status = undefined,
  data = undefined,
  result = undefined,
  errorMessage = undefined,
}) {
  const endpoint = `${context.baseUrl}/api/anfo/render-jobs/${encodeURIComponent(jobId)}/events`
  return fetchJson(endpoint, {
    method: 'POST',
    authHeader: context.authHeader,
    body: {
      event_type: eventType,
      message,
      ...(data === undefined ? {} : { data }),
      ...(status === undefined ? {} : { status }),
      ...(result === undefined ? {} : { result }),
      ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
    },
  })
}

async function completeJob(context, jobId, {
  status,
  message,
  result = null,
  errorMessage = null,
}) {
  const endpoint = `${context.baseUrl}/api/anfo/render-jobs/${encodeURIComponent(jobId)}/complete`
  return fetchJson(endpoint, {
    method: 'POST',
    authHeader: context.authHeader,
    body: {
      status,
      message,
      result,
      error_message: errorMessage,
    },
  })
}

async function claimNextJob(context) {
  const endpoint = `${context.baseUrl}/api/anfo/render-jobs/claim`
  let payload
  try {
    payload = await fetchJson(endpoint, {
      method: 'POST',
      authHeader: context.authHeader,
      body: {
        worker_id: context.workerId,
        lease_seconds: context.leaseSeconds,
        types: context.types,
      },
    })
  } catch (error) {
    const message = String(error?.message || error)
    if (message.includes('HTTP 405')) {
      const configHint = context.baseUrlSource === 'scenario.test-script.lunettes_api.base_url'
        ? ' Der Watcher verwendet aktuell den Fallback aus scenario.test-script.lunettes_api.base_url. Falls die Worker-API auf einer anderen Basis-URL liegt, setze scenario.lunettes-job-watcher.base_url explizit.'
        : ''
      throw new Error(`${message} Die Zielinstanz exponiert den Claim-Endpunkt dort nicht.${configHint}`)
    }
    throw error
  }

  return payload?.job || null
}

function terminateChildProcess(child, signal = 'SIGTERM') {
  if (!child) {
    return
  }

  const canKillProcessGroup = process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0
  try {
    if (canKillProcessGroup) {
      process.kill(-child.pid, signal)
      return
    }
    child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Ignore kill errors for already exiting processes.
    }
  }
}

function terminateChildProcessWithGrace(child) {
  terminateChildProcess(child, 'SIGTERM')
  setTimeout(() => {
    terminateChildProcess(child, 'SIGKILL')
  }, scriptTerminationGracePeriodMs)
}

async function ensureDir(pathValue) {
  await mkdir(pathValue, { recursive: true })
}

function buildScenarioCacheDirName(szenarioId) {
  const normalized = sanitizeFileToken(szenarioId, 'scenario')
  return `szenario-${normalized}`
}

function resolveScenarioCacheDir(szenarioId) {
  return join(scenarioCacheRoot, buildScenarioCacheDirName(szenarioId))
}

function resolveCanonicalScenarioXmlPath(szenarioId) {
  return join(resolveScenarioCacheDir(szenarioId), 'source.xml')
}

async function persistScenarioXml({ job, xmlRaw }) {
  const fallbackScenarioId = sanitizeFileToken(job?.szenario_id || `job-${job?.id || 'unknown'}`, 'scenario')
  const identity = parseScenarioIdentityFromXml(xmlRaw, fallbackScenarioId)
  const lunettesScenarioId = job?.szenario_id || fallbackScenarioId
  const scenarioDir = resolveScenarioCacheDir(lunettesScenarioId)
  const versionToken = sanitizeFileToken(identity.scenarioVersion, 'unknown')
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const canonicalPath = resolveCanonicalScenarioXmlPath(lunettesScenarioId)
  const versionedPath = join(scenarioDir, `${versionToken}-job-${job.id}-${timestamp}.xml`)
  const jobDir = join(jobsRoot, String(job.id))
  const jobScenarioPath = join(jobDir, 'scenario.xml')
  const cacheMetaPath = join(scenarioDir, 'cache-meta.json')

  await ensureDir(scenarioDir)
  await ensureDir(jobDir)
  await writeFile(canonicalPath, xmlRaw, 'utf8')
  await writeFile(versionedPath, xmlRaw, 'utf8')
  await writeFile(jobScenarioPath, xmlRaw, 'utf8')
  await writeFile(cacheMetaPath, JSON.stringify({
    szenario_id: job?.szenario_id ?? null,
    scenario_id: identity.scenarioId,
    scenario_version: identity.scenarioVersion,
    title: identity.title,
    canonical_path: relative(workspaceRoot, canonicalPath),
    updated_at: new Date().toISOString(),
  }, null, 2), 'utf8')

  return {
    ...identity,
    lunettesScenarioId: job?.szenario_id ?? null,
    scenarioDir,
    canonicalPath,
    versionedPath,
    jobScenarioPath,
  }
}

async function resolveLatestScenarioXmlFromCache(szenarioId) {
  const scenarioDir = resolveScenarioCacheDir(szenarioId)
  const canonicalPath = resolveCanonicalScenarioXmlPath(szenarioId)
  if (existsSync(canonicalPath)) {
    return canonicalPath
  }

  if (!existsSync(scenarioDir)) {
    return null
  }

  const entries = await readdir(scenarioDir, { withFileTypes: true })
  const xmlEntries = []
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.xml') {
      continue
    }
    const absolutePath = join(scenarioDir, entry.name)
    const fileStat = await stat(absolutePath)
    xmlEntries.push({
      absolutePath,
      mtimeMs: fileStat.mtimeMs,
    })
  }

  xmlEntries.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const latestXmlPath = xmlEntries[0]?.absolutePath || null
  if (!latestXmlPath) {
    return null
  }

  const latestXmlRaw = await readFile(latestXmlPath, 'utf8')
  await writeFile(canonicalPath, latestXmlRaw, 'utf8')
  return canonicalPath
}

async function resolveScenarioInput(job) {
  const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {}
  const payloadXml = typeof payload.szenario === 'string' ? payload.szenario.trim() : ''
  if (payloadXml) {
    const persisted = await persistScenarioXml({ job, xmlRaw: payloadXml })
    return {
      scenarioPath: persisted.canonicalPath,
      scenarioMeta: persisted,
      source: 'payload',
    }
  }

  const cachedPath = await resolveLatestScenarioXmlFromCache(job?.szenario_id)
  if (!cachedPath) {
    throw new Error(`Kein Szenario-XML fuer szenario_id=${job?.szenario_id} im Payload oder Cache gefunden.`)
  }

  const xmlRaw = await readFile(cachedPath, 'utf8')
  return {
    scenarioPath: cachedPath,
    scenarioMeta: parseScenarioIdentityFromXml(xmlRaw, sanitizeFileToken(job?.szenario_id, 'scenario')),
    source: 'cache',
  }
}

async function runCommandWithLog({
  command,
  args,
  env,
  logPath,
  onSpawn = null,
  onStdout = null,
  onStderr = null,
  inactivityTimeoutMs = null,
  onInactivityTimeout = null,
}) {
  await ensureDir(dirname(logPath))
  const logStream = createWriteStream(logPath, { flags: 'a' })
  let outputTail = ''

  const appendTail = (chunk) => {
    outputTail += chunk
    if (outputTail.length > tailLimitChars) {
      outputTail = outputTail.slice(outputTail.length - tailLimitChars)
    }
  }

  const startedAt = Date.now()

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let inactivityTimer = null
    let forceKillTimer = null
    let timedOut = false
    if (typeof onSpawn === 'function') {
      onSpawn(child)
    }

    const clearTimers = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer)
        inactivityTimer = null
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
    }

    const armInactivityTimer = () => {
      if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
        return
      }
      if (inactivityTimer) {
        clearTimeout(inactivityTimer)
      }
      inactivityTimer = setTimeout(() => {
        timedOut = true
        if (typeof onInactivityTimeout === 'function') {
          onInactivityTimeout()
        }
        terminateChildProcess(child, 'SIGTERM')
        forceKillTimer = setTimeout(() => {
          terminateChildProcess(child, 'SIGKILL')
        }, scriptTerminationGracePeriodMs)
      }, inactivityTimeoutMs)
    }

    armInactivityTimer()

    child.on('error', (error) => {
      clearTimers()
      logStream.end()
      rejectPromise(error)
    })

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      armInactivityTimer()
      process.stdout.write(text)
      logStream.write(text)
      appendTail(text)
      if (typeof onStdout === 'function') {
        onStdout(text)
      }
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      armInactivityTimer()
      process.stderr.write(text)
      logStream.write(text)
      appendTail(text)
      if (typeof onStderr === 'function') {
        onStderr(text)
      }
    })

    child.on('close', (code) => {
      clearTimers()
      logStream.end()
      resolvePromise({
        exitCode: Number(code ?? 1),
        durationMs: Date.now() - startedAt,
        outputTail: outputTail.trim(),
        timedOut,
      })
    })
  })
}

function createJobConsoleEventReporter({ context, jobId }) {
  let queue = Promise.resolve()
  let pendingLines = []
  let stdoutRemainder = ''
  let stderrRemainder = ''
  let canceled = false
  let cancelCallbackInvoked = false
  let flushTimer = null

  function markCanceled() {
    canceled = true
    if (!cancelCallbackInvoked && typeof context.onRemoteCancel === 'function') {
      cancelCallbackInvoked = true
      context.onRemoteCancel()
    }
  }

  function enqueueEvent(lines, stream) {
    const payloadLines = lines
      .map((line) => truncateText(line, jobEventLogLineMaxLength))
      .filter(Boolean)
    if (payloadLines.length === 0) {
      return
    }

    queue = queue
      .catch(() => {})
      .then(() => postJobEvent(context, jobId, {
        eventType: 'progress',
        message: payloadLines.join('\n'),
        data: {
          source: 'script-console',
          stream,
          lines: payloadLines,
        },
      }))
      .catch((error) => {
        if (isJobCanceledConflict(error)) {
          markCanceled()
          return
        }
        console.error(`[job ${jobId}] Konnte Konsolen-Event nicht an Lunettes senden: ${error.message}`)
      })
  }

  function clearFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  function armFlushTimer() {
    clearFlushTimer()
    if (pendingLines.length === 0) {
      return
    }
    flushTimer = setTimeout(() => {
      flushPendingBatch()
    }, jobEventLogFlushIntervalMs)
  }

  function flushPendingBatch() {
    if (pendingLines.length === 0) {
      return
    }

    clearFlushTimer()
    const linesToSend = pendingLines
    pendingLines = []
    const stream = linesToSend.every((entry) => entry.stream === linesToSend[0].stream)
      ? linesToSend[0].stream
      : 'mixed'
    enqueueEvent(linesToSend.map((entry) => entry.line), stream)
  }

  function pushChunk(chunk, stream) {
    const text = String(chunk || '')
    const priorRemainder = stream === 'stderr' ? stderrRemainder : stdoutRemainder
    const { completeLines, trailing } = splitCompleteLines(priorRemainder + text)

    if (stream === 'stderr') {
      stderrRemainder = trailing
    } else {
      stdoutRemainder = trailing
    }

    for (const line of completeLines) {
      pendingLines.push({
        stream,
        line,
      })
      if (pendingLines.length >= jobEventLogBatchSize) {
        flushPendingBatch()
        continue
      }
      armFlushTimer()
    }
  }

  async function flush() {
    clearFlushTimer()
    if (stdoutRemainder.trim()) {
      pendingLines.push({
        stream: 'stdout',
        line: stdoutRemainder.trim(),
      })
      stdoutRemainder = ''
    }

    if (stderrRemainder.trim()) {
      pendingLines.push({
        stream: 'stderr',
        line: stderrRemainder.trim(),
      })
      stderrRemainder = ''
    }

    flushPendingBatch()
    await queue
  }

  return {
    get canceled() {
      return canceled
    },
    pushChunk,
    flush,
  }
}

async function runCommandWithLogAndEvents({ command, args, env, logPath, context, jobId }) {
  let childRef = null
  let remoteCanceled = false
  const reporter = createJobConsoleEventReporter({
    context: {
      ...context,
      onRemoteCancel: () => {
        remoteCanceled = true
        console.warn(`[job ${jobId}] Lunettes meldet job_canceled. Prozess wird beendet.`)
        terminateChildProcessWithGrace(childRef)
      },
    },
    jobId,
  })
  const result = await runCommandWithLog({
    command,
    args,
    env,
    logPath,
    onSpawn: (child) => {
      childRef = child
    },
    onStdout: (text) => reporter.pushChunk(text, 'stdout'),
    onStderr: (text) => reporter.pushChunk(text, 'stderr'),
    inactivityTimeoutMs: scriptInactivityTimeoutMs,
    onInactivityTimeout: () => {
      console.error(`[job ${jobId}] Script-Inaktivitaet > ${Math.floor(scriptInactivityTimeoutMs / 1000)}s, Prozess wird mit SIGTERM beendet. Nach ${Math.floor(scriptTerminationGracePeriodMs / 1000)}s folgt SIGKILL, falls noetig.`)
      reporter.pushChunk(
        `Watcher: Keine Konsolenausgabe seit ${Math.floor(scriptInactivityTimeoutMs / 1000)} Sekunden. Prozess wird mit SIGTERM beendet. Nach ${Math.floor(scriptTerminationGracePeriodMs / 1000)} Sekunden folgt SIGKILL, falls noetig.\n`,
        'stderr',
      )
    },
  })
  await reporter.flush()
  return {
    ...result,
    remoteCanceled: remoteCanceled || reporter.canceled,
  }
}

function resolveDefaultVideoProfile(videoScriptConfig, watcherConfig) {
  const configuredProfile = String(watcherConfig?.video_profile || '').trim()
  if (configuredProfile) {
    return configuredProfile
  }

  const ttsProfiles = Array.isArray(videoScriptConfig?.tts) ? videoScriptConfig.tts : []
  const firstProfile = ttsProfiles.find((entry) => String(entry?.profile || '').trim())
  return String(firstProfile?.profile || 'all-channels').trim() || 'all-channels'
}

async function findLatestScenarioRunMeta(scenarioId) {
  const folderName = buildScenarioOutputFolderName({ scenarioId, fallbackName: 'scenario' })
  const runsDir = resolve(workspaceRoot, 'output', folderName, 'runs')
  if (!existsSync(runsDir)) {
    return null
  }

  const entries = await readdir(runsDir, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const runMetaPath = join(runsDir, entry.name, 'run-meta.json')
    if (!existsSync(runMetaPath)) {
      continue
    }
    try {
      const raw = await readFile(runMetaPath, 'utf8')
      const parsed = JSON.parse(raw)
      const fileStat = await stat(runMetaPath)
      candidates.push({
        runMetaPath,
        parsed,
        mtimeMs: fileStat.mtimeMs,
      })
    } catch {
      // Ignore broken metadata files and use the next candidate.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0] || null
}

async function findLatestVideoRenderMeta(scenarioId) {
  const folderName = buildScenarioOutputFolderName({ scenarioId, fallbackName: 'scenario' })
  const ttsDir = resolve(workspaceRoot, 'output', folderName, 'videogenerator')
  if (!existsSync(ttsDir)) {
    return null
  }

  const entries = await readdir(ttsDir, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^scenario-tts-remotion-render-.*\.json$/i.test(entry.name)) {
      continue
    }
    const metaPath = join(ttsDir, entry.name)
    try {
      const raw = await readFile(metaPath, 'utf8')
      const parsed = JSON.parse(raw)
      const fileStat = await stat(metaPath)
      if (!parsed?.outputVideo) {
        continue
      }
      candidates.push({
        metaPath,
        parsed,
        mtimeMs: fileStat.mtimeMs,
      })
    } catch {
      // Ignore malformed metadata.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0] || null
}

function buildTestscriptCommand({ scenarioPath, payload, context }) {
  const scenarioPathArg = toWorkspaceRelativePath(scenarioPath)
  const scenarioId = sanitizeFileToken(payload?.szenario_id, '')
  if (!scenarioId) {
    throw new Error('Job enthaelt keine szenario_id im Payload.')
  }
  const outDir = toWorkspaceRelativePath(join(runtimeRoot, 'testfiles', scenarioId))
  const args = appendFragmentSourceArg([
    'scripts/test-script-generator/run-generated-testfile.mjs',
    scenarioPathArg,
    '--scenario-id',
    scenarioId,
    '--out-dir',
    outDir,
    '--force',
    '--mode',
    allowedTestModes.has(String(payload?.mode || '').trim())
      ? String(payload.mode).trim()
      : context.testscriptMode,
  ], 'lunettes')

  if (payload?.verbose === true) {
    args.push('--verbose')
  }

  if (Array.isArray(payload?.playwright_args) && payload.playwright_args.length > 0) {
    args.push('--', ...payload.playwright_args.map((entry) => String(entry)))
  }

  return {
    command: 'node',
    args,
    env: process.env,
  }
}

function buildVideoscriptCommand({ scenarioPath, payload, context }) {
  const scenarioPathArg = toWorkspaceRelativePath(scenarioPath)
  const scenarioId = sanitizeFileToken(payload?.szenario_id, '')
  if (!scenarioId) {
    throw new Error('Job enthaelt keine szenario_id im Payload.')
  }
  const profile = String(payload?.profile || context.videoProfile || 'all-channels').trim() || 'all-channels'
  const args = appendFragmentSourceArg([
    'scripts/video-script-generator/remotion-render.mjs',
    scenarioPathArg,
    `--scenario-id=${scenarioId}`,
    `--profile=${profile}`,
  ], 'lunettes')

  if (typeof payload?.tts_voice === 'string' && payload.tts_voice.trim()) {
    args.push(`--tts-voice=${payload.tts_voice.trim()}`)
  }
  if (payload?.keep_temp_project === true) {
    args.push('--keep-temp-project')
  }
  if (payload?.verbose === true) {
    args.push('--verbose')
  }

  return {
    command: 'node',
    args,
    env: {
      ...process.env,
    },
  }
}

function buildPublishCommand({ scenarioPath, payload }) {
  const scenarioPathArg = toWorkspaceRelativePath(scenarioPath)
  const scenarioId = sanitizeFileToken(payload?.szenario_id, '')
  const confluencePageId = String(payload?.confluence_page_id || '').trim()
  const scenarioTitle = String(payload?.titel || '').trim()
  if (!scenarioId) {
    throw new Error('Publish-Job enthaelt keine szenario_id im Payload.')
  }
  if (!confluencePageId) {
    throw new Error('Publish-Job enthaelt keine confluence_page_id im Payload.')
  }

  return {
    command: 'node',
    args: [
      'scripts/publish-to-confluence/publish-scenario-to-confluence.mjs',
      scenarioPathArg,
      confluencePageId,
      `--scenario-id=${scenarioId}`,
      `--scenario-title=${scenarioTitle}`,
    ],
    env: {
      ...process.env,
    },
  }
}

async function buildJobExecutionPlan(job, context, scenarioInput) {
  const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {}

  if (job.type === 'testscript') {
    return {
      label: 'Testscript ausfuehren',
      ...buildTestscriptCommand({
        scenarioPath: scenarioInput.scenarioPath,
        payload,
        context,
      }),
    }
  }

  if (job.type === 'videoscript') {
    return {
      label: 'Videoscript rendern',
      ...buildVideoscriptCommand({
        scenarioPath: scenarioInput.scenarioPath,
        payload,
        context,
      }),
    }
  }

  if (job.type === 'publish') {
    return {
      label: 'Publish ausfuehren',
      ...buildPublishCommand({
        scenarioPath: scenarioInput.scenarioPath,
        payload,
      }),
    }
  }

  throw new Error(`Nicht unterstuetzter Job-Typ: ${job.type}`)
}

async function buildJobResult(job, scenarioInput, logPath) {
  const scenarioPathRelative = relative(workspaceRoot, scenarioInput.scenarioPath)
  const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {}
  const scenarioId = sanitizeFileToken(payload?.szenario_id, scenarioInput.scenarioMeta.scenarioId || 'scenario')
  const baseResult = {
    job_type: job.type,
    szenario_id: job.szenario_id,
    payload_szenario_id: scenarioId,
    scenario_path: scenarioPathRelative,
    xml_source: scenarioInput.source,
    log_path: relative(workspaceRoot, logPath),
  }

  if (job.type === 'testscript') {
    const latestRun = await findLatestScenarioRunMeta(scenarioId)
    return {
      ...baseResult,
      ...(latestRun?.parsed?.exportedTo
        ? {
          run_root: latestRun.parsed.exportedTo.rootRelative || null,
          artifacts_dir: latestRun.parsed.exportedTo.artifactsRelative || null,
          generated_dir: latestRun.parsed.exportedTo.generatedRelative || null,
        }
        : {}),
      run_meta_path: latestRun ? relative(workspaceRoot, latestRun.runMetaPath) : null,
    }
  }

  if (job.type === 'videoscript') {
    const latestRender = await findLatestVideoRenderMeta(scenarioId)
    return {
      ...baseResult,
      render_meta_path: latestRender ? relative(workspaceRoot, latestRender.metaPath) : null,
      output_video: latestRender?.parsed?.outputVideo
        ? relative(workspaceRoot, resolve(String(latestRender.parsed.outputVideo)))
        : null,
      render_plan_path: latestRender?.parsed?.renderPlanPath
        ? relative(workspaceRoot, resolve(String(latestRender.parsed.renderPlanPath)))
        : null,
    }
  }

  return baseResult
}

async function processJob(job, context) {
  const jobDir = join(jobsRoot, String(job.id))
  await ensureDir(jobDir)
  const logPath = join(jobDir, 'job.log')
  const scenarioInput = await resolveScenarioInput(job)
  const scenarioPathRelative = relative(workspaceRoot, scenarioInput.scenarioPath)
  const plan = await buildJobExecutionPlan(job, context, scenarioInput)

  try {
    await postJobEvent(context, job.id, {
      eventType: 'progress',
      status: 'running',
      message: `${plan.label} gestartet.`,
      data: {
        worker_id: context.workerId,
        scenario_path: scenarioPathRelative,
        xml_source: scenarioInput.source,
        command: [plan.command, ...plan.args].join(' '),
      },
    })
  } catch (error) {
    if (isJobCanceledConflict(error)) {
      throw new JobCanceledError('Job wurde vor dem Script-Start serverseitig abgebrochen.')
    }
    throw error
  }

  console.log(`[job ${job.id}] ${plan.label}: ${scenarioPathRelative}`)
  const commandResult = await runCommandWithLogAndEvents({
    command: plan.command,
    args: plan.args,
    env: plan.env,
    logPath,
    context,
    jobId: job.id,
  })

  if (commandResult.remoteCanceled) {
    throw new JobCanceledError('Job wurde waehrend der Skriptausfuehrung serverseitig abgebrochen.')
  }

  if (commandResult.exitCode !== 0) {
    if (commandResult.timedOut) {
      throw new Error(
        truncateText(
          commandResult.outputTail || `Keine Konsolenausgabe fuer mehr als ${Math.floor(scriptInactivityTimeoutMs / 1000)} Sekunden.`,
          1500,
        )
      )
    }
    throw new Error(
      truncateText(
        commandResult.outputTail || `${plan.label} fehlgeschlagen (Exit-Code ${commandResult.exitCode}).`,
        1500,
      )
    )
  }

  const result = await buildJobResult(job, scenarioInput, logPath)
  result.duration_ms = commandResult.durationMs

  try {
    await completeJob(context, job.id, {
      status: 'succeeded',
      message: `${plan.label} abgeschlossen.`,
      result,
    })
  } catch (error) {
    if (isJobCanceledConflict(error)) {
      throw new JobCanceledError('Job wurde nach Skriptausfuehrung serverseitig abgebrochen.')
    }
    throw error
  }

  console.log(`[job ${job.id}] abgeschlossen`)
}

function buildWatcherContext(cliOptions) {
  const central = loadCentralConfig(workspaceRoot)
  const testScriptConfig = getTestScriptConfig(central.config)
  const videoScriptConfig = getVideoScriptConfig(central.config)
  const watcherConfig = central.config?.['lunettes-job-watcher'] || {}

  let baseUrlSource = ''
  let baseUrl = ''
  if (cliOptions.baseUrl) {
    baseUrl = normalizeBaseUrl(cliOptions.baseUrl)
    baseUrlSource = 'cli --base-url'
  } else if (watcherConfig.base_url) {
    baseUrl = normalizeBaseUrl(watcherConfig.base_url)
    baseUrlSource = 'scenario.lunettes-job-watcher.base_url'
  } else {
    baseUrl = normalizeBaseUrl(testScriptConfig?.lunettes_api?.base_url)
    baseUrlSource = 'scenario.test-script.lunettes_api.base_url'
  }
  if (!baseUrl) {
    throw new Error('Lunettes API base_url fehlt. Erwartet: scenario.config.json > scenario["lunettes-job-watcher"].base_url oder scenario["test-script"].lunettes_api.base_url')
  }

  const username = String(process.env.LUNETTES_API_USERNAME || '').trim()
  const password = String(process.env.LUNETTES_API_PASSWORD || '')
  if (!username || !password) {
    throw new Error('LUNETTES_API_USERNAME oder LUNETTES_API_PASSWORD fehlt.')
  }

  const workerId = String(
    cliOptions.workerId
    || process.env.LUNETTES_JOB_WORKER_ID
    || watcherConfig.worker_id
    || `${hostname()}-${process.pid}`
  ).trim()

  const types = normalizeTypes(cliOptions.types || watcherConfig.types)
  const leaseSeconds = clampNumber(cliOptions.leaseSeconds || watcherConfig.lease_seconds, 30, 86400, 14400)
  const pollIntervalMs = clampNumber(cliOptions.pollIntervalMs || watcherConfig.poll_interval_ms, 1000, 600000, 15000)
  const testscriptModeRaw = String(watcherConfig.testscript_mode || 'video').trim().toLowerCase()
  const testscriptMode = allowedTestModes.has(testscriptModeRaw) ? testscriptModeRaw : 'video'
  const videoProfile = resolveDefaultVideoProfile(videoScriptConfig, watcherConfig)

  return {
    baseUrl,
    baseUrlSource,
    authHeader: buildBasicAuthHeader(username, password),
    workerId,
    types,
    leaseSeconds,
    pollIntervalMs,
    testscriptMode,
    videoProfile,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const context = buildWatcherContext(options)
  await ensureDir(runtimeRoot)
  await ensureDir(jobsRoot)
  await ensureDir(scenarioCacheRoot)

  console.log(`Lunettes Job Watcher aktiv: worker_id=${context.workerId}, types=${context.types.join(',')}, lease=${context.leaseSeconds}s`)
  console.log(`[watcher] base_url=${context.baseUrl} (${context.baseUrlSource})`)

  while (true) {
    let job = null
    try {
      job = await claimNextJob(context)
    } catch (error) {
      console.error(`[watcher] Claim fehlgeschlagen: ${error.message}`)
      if (options.once) {
        throw error
      }
      await sleep(context.pollIntervalMs)
      continue
    }

    if (!job) {
      console.log(`[watcher] Kein passender Job. Naechster Poll in ${context.pollIntervalMs} ms.`)
      if (options.once) {
        return
      }
      await sleep(context.pollIntervalMs)
      continue
    }

    try {
      await processJob(job, context)
    } catch (error) {
      if (error instanceof JobCanceledError) {
        console.log(`[job ${job.id}] abgebrochen: ${error.message}`)
        if (options.once) {
          return
        }
        continue
      }
      const logPath = join(jobsRoot, String(job.id), 'job.log')
      const errorMessage = truncateText(error?.message || String(error), 1500) || 'Unbekannter Fehler'
      console.error(`[job ${job.id}] fehlgeschlagen: ${errorMessage}`)
      try {
        await completeJob(context, job.id, {
          status: 'failed',
          message: `Job fehlgeschlagen: ${errorMessage}`,
          result: {
            job_type: job.type,
            szenario_id: job.szenario_id,
            log_path: existsSync(logPath) ? relative(workspaceRoot, logPath) : null,
          },
          errorMessage,
        })
      } catch (completeError) {
        console.error(`[job ${job.id}] Konnte Fehlerstatus nicht an Lunettes melden: ${completeError.message}`)
      }

      if (options.once) {
        throw error
      }
    }

    if (options.once) {
      return
    }
  }
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
