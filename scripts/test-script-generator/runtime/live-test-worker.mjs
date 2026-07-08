import { mkdir, writeFile } from 'fs/promises'
import { Buffer } from 'buffer'
import { join, resolve } from 'path'
import { chromium } from '@playwright/test'
import { scenarioToSpecSource } from '../generate-tests-from-scenario-xml.mjs'
import {
  createScenarioExecutionRuntime,
  createScenarioExecutionState,
  prepareScenarioFlow,
  runPreparedScenarioFlow,
  seedRuntimeVariables,
} from './scenario-helpers.mjs'

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function buildBasicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

function serializeError(error) {
  if (!error) {
    return null
  }

  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error),
    ...(error?.stack ? { stack: String(error.stack) } : {}),
  }
}

export function normalizeScriptLineToScenarioXml(scriptLine) {
  const text = String(scriptLine || '').trim()
  if (!text) {
    throw new Error('Leerer Live-Test-Schritt.')
  }

  if (text.startsWith('<?xml') || text.startsWith('<SzenarioScript')) {
    return text
  }

  if (text.startsWith('<Gruppe')) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<SzenarioScript>',
      `  ${text}`,
      '</SzenarioScript>',
      '',
    ].join('\n')
  }

  if (text.startsWith('<Variablen')) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<SzenarioScript>',
      `  ${text}`,
      '</SzenarioScript>',
      '',
    ].join('\n')
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<SzenarioScript>',
    '  <Gruppe>',
    `    ${text}`,
    '  </Gruppe>',
    '</SzenarioScript>',
    '',
  ].join('\n')
}

async function captureStepArtifacts(page) {
  let url = null
  let html = null
  let screenshot = null

  try {
    url = page.url()
  } catch {
    url = null
  }

  try {
    html = await page.content()
  } catch {
    html = null
  }

  try {
    const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true })
    screenshot = screenshotBuffer.toString('base64')
  } catch {
    screenshot = null
  }

  return { url, html, screenshot }
}

function isNoClaimableLiveTestError(error) {
  const statusCode = Number(error?.statusCode)
  const responsePayload = error?.responsePayload
  const payloadText = responsePayload == null
    ? ''
    : typeof responsePayload === 'string'
      ? responsePayload
      : JSON.stringify(responsePayload)

  return statusCode === 409
    && payloadText.toLowerCase().includes('kein claimbarer live-test gefunden')
}

export class LunettesLiveTestClient {
  constructor({ baseUrl, username, password, fetchImpl = fetch }) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.authHeader = buildBasicAuthHeader(username, password)
    this.fetch = fetchImpl
  }

  async request(path, { method = 'POST', body = undefined } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: this.authHeader,
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
      const error = new Error(`HTTP ${response.status} ${response.statusText} for ${method} ${path}.${details}`)
      error.statusCode = response.status
      error.responsePayload = payload
      error.path = path
      error.method = method
      throw error
    }

    return payload
  }

  register({ workerName, workerSessionId = null }) {
    return this.request('/api/live-test-workers/register', {
      body: {
        worker_name: workerName,
        ...(workerSessionId ? { worker_session_id: workerSessionId } : {}),
      },
    })
  }

  claimLiveTest(sessionId, liveTestId = null) {
    return this.request(`/api/live-test-workers/${encodeURIComponent(sessionId)}/claim-live-test`, {
      body: liveTestId == null ? undefined : { liveTestId },
    })
  }

  nextStep(sessionId) {
    return this.request(`/api/live-test-workers/${encodeURIComponent(sessionId)}/next-step`)
  }

  stepResult(sessionId, payload) {
    return this.request(`/api/live-test-workers/${encodeURIComponent(sessionId)}/step-result`, {
      body: payload,
    })
  }

  heartbeat(sessionId) {
    return this.request(`/api/live-test-workers/${encodeURIComponent(sessionId)}/heartbeat`)
  }

  release(sessionId, reason = 'worker_shutdown') {
    return this.request(`/api/live-test-workers/${encodeURIComponent(sessionId)}/release`, {
      body: { reason },
    })
  }
}

export class LiveTestWorkerRunner {
  constructor({
    client,
    workerName,
    workerSessionId = null,
    liveTestId = null,
    pollIntervalMs = 1000,
    heartbeatIntervalMs = 30000,
    reRegisterAfterIdleMs = 15000,
    browserFactory = () => chromium.launch({ headless: true }),
    resolveScenarioSteps,
    runtimeRoot = resolve(process.cwd(), 'temp', 'live-test-workers'),
    xsdPath = resolve(process.cwd(), 'schemas', 'szenarioscript.xsd'),
    testScriptConfig = {},
    fragmentSource = 'lunettes',
    sleepImpl = sleep,
  }) {
    this.client = client
    this.workerName = String(workerName || 'live-test-worker')
    this.workerSessionId = workerSessionId ? String(workerSessionId) : null
    this.liveTestId = liveTestId == null || String(liveTestId).trim() === '' ? null : String(liveTestId).trim()
    this.pollIntervalMs = Math.max(250, Number(pollIntervalMs) || 1000)
    this.heartbeatIntervalMs = Math.max(1000, Number(heartbeatIntervalMs) || 30000)
    this.reRegisterAfterIdleMs = Math.max(0, Number(reRegisterAfterIdleMs) || 0)
    this.browserFactory = browserFactory
    this.runtimeRoot = runtimeRoot
    this.xsdPath = xsdPath
    this.testScriptConfig = testScriptConfig
    this.fragmentSource = fragmentSource
    this.sleep = sleepImpl
    this.browser = null
    this.page = null
    this.sessionId = null
    this.lastHeartbeatAt = 0
    this.currentArtifactDir = null
    this.executionState = null
    this.idleWithoutLiveTestSince = 0
    this.resolveScenarioSteps = resolveScenarioSteps || (async (scriptLine, context) => {
      const xmlSource = normalizeScriptLineToScenarioXml(scriptLine)
      const xmlPath = join(context.artifactDir, 'step.xml')
      const generatedSpecPath = join(context.artifactDir, 'step.generated.spec.js')
      await mkdir(context.artifactDir, { recursive: true })
      await writeFile(xmlPath, xmlSource, 'utf8')
      const resolved = await scenarioToSpecSource({
        scenarioPath: xmlPath,
        xsdPath: this.xsdPath,
        centralConfig: this.testScriptConfig,
        generatedSpecPath,
        fragmentSource: this.fragmentSource,
        allowEmptyFlow: true,
      })
      return resolved.resolvedRoot
    })
  }

  async ensureBrowserSession() {
    if (this.page) {
      return
    }

    this.browser = await this.browserFactory()
    this.page = await this.browser.newPage()
    const outputPath = (filename) => join(this.currentArtifactDir || this.runtimeRoot, filename)
    this.executionState = createScenarioExecutionState({
      page: this.page,
      testInfo: { outputPath },
      runtimeVariables: {},
      smoothScrollEnabled: false,
      scrollDelayMs: Number(this.testScriptConfig?.video?.scroll_delay_ms ?? 35),
    })
  }

  async closeBrowserSession() {
    try {
      await this.page?.close?.()
    } catch {
      // Ignore close errors.
    }
    try {
      await this.browser?.close?.()
    } catch {
      // Ignore close errors.
    }
    this.page = null
    this.browser = null
    this.executionState = null
  }

  async register() {
    const response = await this.client.register({
      workerName: this.workerName,
      workerSessionId: this.workerSessionId,
    })
    this.sessionId = String(response?.sessionId || '')
    this.lastHeartbeatAt = Date.now()
    this.idleWithoutLiveTestSince = 0
    console.log(`[live-test-worker] registered session_id=${this.sessionId} status=${String(response?.status || 'unknown')}`)
    return response
  }

  async claimLiveTest() {
    if (!this.sessionId) {
      throw new Error('Cannot claim live test without session_id.')
    }

    let response
    try {
      response = await this.client.claimLiveTest(this.sessionId, this.liveTestId)
    } catch (error) {
      if (isNoClaimableLiveTestError(error)) {
        this.idleWithoutLiveTestSince = 0
        console.log(`[live-test-worker] claim pending session_id=${this.sessionId} mode=${this.liveTestId ? 'explicit' : 'latest-running'} reason=no-claimable-live-test`)
        return null
      }
      throw error
    }
    const claimedLiveTestId = response?.liveTest?.id ?? this.liveTestId ?? null
    console.log(`[live-test-worker] claimed session_id=${this.sessionId} live_test_id=${String(claimedLiveTestId ?? '') || '-'} mode=${this.liveTestId ? 'explicit' : 'latest-running'}`)
    return response
  }

  async maybeReregisterAfterIdleWait(next) {
    if (this.workerSessionId || this.reRegisterAfterIdleMs <= 0) {
      return false
    }
    if (next?.type !== 'wait' || next?.liveTestId != null) {
      this.idleWithoutLiveTestSince = 0
      return false
    }

    const now = Date.now()
    if (!this.idleWithoutLiveTestSince) {
      this.idleWithoutLiveTestSince = now
      return false
    }
    if (now - this.idleWithoutLiveTestSince < this.reRegisterAfterIdleMs) {
      return false
    }

    const previousSessionId = this.sessionId
    this.idleWithoutLiveTestSince = 0
    console.log(`[live-test-worker] re-register session_id=${previousSessionId} reason=idle_timeout idle_ms=${this.reRegisterAfterIdleMs}`)
    try {
      await this.client.release(previousSessionId, 'idle_timeout_reregister')
    } catch (error) {
      console.log(`[live-test-worker] release-before-reregister failed session_id=${previousSessionId} message=${String(error?.message || error)}`)
    }
    await this.register()
    await this.claimLiveTest()
    return true
  }

  async maybeHeartbeat() {
    if (!this.sessionId) {
      return
    }
    if (Date.now() - this.lastHeartbeatAt < this.heartbeatIntervalMs) {
      return
    }
    await this.client.heartbeat(this.sessionId)
    this.lastHeartbeatAt = Date.now()
    console.log(`[live-test-worker] heartbeat session_id=${this.sessionId}`)
  }

  async executeLeasedStep(payload) {
    await this.ensureBrowserSession()

    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const stepId = payload?.step?.id
    const artifactDir = join(this.runtimeRoot, this.sessionId || 'unregistered', String(stepId || 'step'))
    this.currentArtifactDir = artifactDir
    await mkdir(artifactDir, { recursive: true })

    if (this.executionState) {
      this.executionState.smoothScrollEnabled = Boolean(this.testScriptConfig?.video?.autoscroll_smooth === true)
      this.executionState.scrollDelayMs = Math.max(0, Number(this.testScriptConfig?.video?.scroll_delay_ms ?? 35) || 35)
      this.executionState.testInfo = {
        outputPath: (filename) => join(artifactDir, filename),
      }
    }

    let status = 'success'
    let error = null
    console.log(`[live-test-worker] execute live_test_id=${String(payload?.liveTestId ?? '')} step_id=${String(stepId ?? '')}`)

    try {
      const resolvedRoot = await this.resolveScenarioSteps(payload?.step?.scriptLine, {
        artifactDir,
        sessionId: this.sessionId,
        leasedStep: payload?.step,
      })
      const preparedFlow = prepareScenarioFlow(Array.isArray(resolvedRoot?.flow) ? resolvedRoot.flow : [], { autoScroll: true })
      const waitBetweenStepsMs = Math.max(0, Math.floor(Number(resolvedRoot?.video?.wait_between_steps ?? this.testScriptConfig?.video?.wait_between_steps ?? 0) || 0))
      const stepTimeoutMs = Math.max(0, Math.floor(Number(resolvedRoot?.runtime?.step_timeout_ms ?? this.testScriptConfig?.runtime?.step_timeout_ms ?? 30000) || 30000))
      seedRuntimeVariables(this.executionState?.runtimeVariables, resolvedRoot?.initialRuntimeVariables || {})
      const executionRuntime = createScenarioExecutionRuntime({
        page: this.page,
        waitBetweenStepsMs,
        stepTimeoutMs,
      })

      await runPreparedScenarioFlow({
        steps: preparedFlow,
        executionRuntime,
        executionState: this.executionState,
      })
    } catch (stepError) {
      status = 'failed'
      error = serializeError(stepError)
    }

    const finishedAtMs = Date.now()
    const finishedAt = new Date(finishedAtMs).toISOString()
    const artifacts = await captureStepArtifacts(this.page)

    const resultPayload = {
      liveTestId: payload?.liveTestId,
      stepId,
      status,
      error,
      url: artifacts.url,
      html: artifacts.html,
      screenshot: artifacts.screenshot,
      startedAt,
      finishedAt,
      durationMs: finishedAtMs - startedAtMs,
    }

    await this.client.stepResult(this.sessionId, resultPayload)
    console.log(`[live-test-worker] result live_test_id=${String(payload?.liveTestId ?? '')} step_id=${String(stepId ?? '')} status=${status} duration_ms=${resultPayload.durationMs}`)
    return resultPayload
  }

  async run() {
    await mkdir(this.runtimeRoot, { recursive: true })
    if (!this.sessionId) {
      await this.register()
    }
    await this.claimLiveTest()

    while (true) {
      await this.maybeHeartbeat()
      const next = await this.client.nextStep(this.sessionId)

      if (next?.type === 'wait') {
        if (await this.maybeReregisterAfterIdleWait(next)) {
          continue
        }
        console.log(`[live-test-worker] wait session_id=${this.sessionId} live_test_id=${String(next?.liveTestId ?? '') || '-'}`)
        await this.sleep(this.pollIntervalMs)
        continue
      }

      if (next?.type === 'release') {
        console.log(`[live-test-worker] release session_id=${this.sessionId} reason=${String(next?.reason || 'unknown')}`)
        await this.closeBrowserSession()
        await this.client.release(this.sessionId, String(next?.reason || 'live_test_finished'))
        return next
      }

      if (next?.type === 'step') {
        this.idleWithoutLiveTestSince = 0
        console.log(`[live-test-worker] leased live_test_id=${String(next?.liveTestId ?? '')} step_id=${String(next?.step?.id ?? '')} position=${String(next?.step?.position ?? '')}`)
        await this.executeLeasedStep(next)
        continue
      }

      console.log(`[live-test-worker] unexpected response type=${String(next?.type || 'unknown')}`)
      await this.sleep(this.pollIntervalMs)
    }
  }
}
