import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createScenarioExecutionRuntime,
  createScenarioExecutionState,
  runPreparedScenarioFlow,
  resolveRuntimeTemplateString,
} from './scenario-helpers.mjs'
import { LiveTestWorkerRunner, normalizeScriptLineToScenarioXml } from './live-test-worker.mjs'
import { scenarioToSpecSource } from '../generate-tests-from-scenario-xml.mjs'

function createFakePage() {
  const handlers = new Map()

  return {
    urlValue: 'about:blank',
    gotoCalls: [],
    waitCalls: [],
    async goto(url) {
      this.gotoCalls.push(url)
      if (String(url).includes('broken')) {
        throw new Error('boom')
      }
      this.urlValue = String(url)
    },
    async waitForTimeout(ms) {
      this.waitCalls.push(ms)
    },
    url() {
      return this.urlValue
    },
    async content() {
      return `<html><body>${this.urlValue}</body></html>`
    },
    async screenshot() {
      return Buffer.from('png')
    },
    on(eventName, handler) {
      handlers.set(eventName, handler)
    },
    async close() {
      return undefined
    },
  }
}

test('live-test snippets are wrapped into SzenarioScript and Gruppe when needed', () => {
  const wrappedStep = normalizeScriptLineToScenarioXml('<Oeffnen url="https://example.test" />')
  assert.match(wrappedStep, /<SzenarioScript>/)
  assert.match(wrappedStep, /<Gruppe>/)
  assert.match(wrappedStep, /<Oeffnen url="https:\/\/example\.test" \/>/)

  const wrappedGroup = normalizeScriptLineToScenarioXml('<Gruppe><Oeffnen url="https://example.test" /></Gruppe>')
  assert.match(wrappedGroup, /<SzenarioScript>/)
  assert.equal((wrappedGroup.match(/<Gruppe>/g) || []).length, 1)
})

test('full-run and live-step-run use the same execution semantics', async () => {
  const flow = [{
    id: 'open-step',
    resolvedId: 'open-step',
    resolvedTitle: 'Open',
    interaction: {
      type: 'open',
      target: {
        url: 'https://example.test/dashboard',
      },
    },
  }]

  const pageFull = createFakePage()
  const executionStateFull = createScenarioExecutionState({
    page: pageFull,
    testInfo: { outputPath: (filename) => filename },
  })
  const runtimeFull = createScenarioExecutionRuntime({
    page: pageFull,
    waitBetweenStepsMs: 250,
    stepTimeoutMs: 30000,
  })

  await runPreparedScenarioFlow({
    steps: flow,
    executionRuntime: runtimeFull,
    executionState: executionStateFull,
  })

  const pageLive = createFakePage()
  const results = []
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'live-test-worker-'))
  const runner = new LiveTestWorkerRunner({
    client: {
      async stepResult(_sessionId, payload) {
        results.push(payload)
      },
    },
    workerName: 'test-worker',
    browserFactory: async () => ({
      async newPage() {
        return pageLive
      },
      async close() {
        return undefined
      },
    }),
    resolveScenarioSteps: async () => ({
      flow,
      video: { wait_between_steps: 250 },
      runtime: { step_timeout_ms: 30000 },
    }),
    runtimeRoot,
    testScriptConfig: {
      video: { wait_between_steps: 250 },
      runtime: { step_timeout_ms: 30000 },
    },
  })
  runner.sessionId = 'session-1'

  const result = await runner.executeLeasedStep({
    liveTestId: 12,
    step: {
      id: 77,
      scriptLine: '<Oeffnen url="https://example.test/dashboard" />',
    },
  })

  assert.deepEqual(pageLive.gotoCalls, pageFull.gotoCalls)
  assert.deepEqual(pageLive.waitCalls, pageFull.waitCalls)
  assert.equal(result.status, 'success')
  assert.equal(results[0].status, 'success')
})

test('live-step-runner reports html and screenshot on success', async () => {
  const page = createFakePage()
  const results = []
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'live-test-worker-'))
  const runner = new LiveTestWorkerRunner({
    client: {
      async stepResult(_sessionId, payload) {
        results.push(payload)
      },
    },
    workerName: 'test-worker',
    browserFactory: async () => ({
      async newPage() {
        return page
      },
      async close() {
        return undefined
      },
    }),
    resolveScenarioSteps: async () => ({
      flow: [{
        id: 'open-step',
        resolvedId: 'open-step',
        interaction: {
          type: 'open',
          target: { url: 'https://example.test/success' },
        },
      }],
      video: { wait_between_steps: 0 },
      runtime: { step_timeout_ms: 30000 },
    }),
    runtimeRoot,
    testScriptConfig: {},
  })
  runner.sessionId = 'session-2'

  await runner.executeLeasedStep({
    liveTestId: 13,
    step: {
      id: 88,
      scriptLine: '<Oeffnen url="https://example.test/success" />',
    },
  })

  assert.equal(results[0].status, 'success')
  assert.equal(results[0].url, 'https://example.test/success')
  assert.match(results[0].html, /example\.test\/success/)
  assert.equal(results[0].screenshot, Buffer.from('png').toString('base64'))
})

test('session stays open after a failed step and can continue', async () => {
  const page = createFakePage()
  const results = []
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'live-test-worker-'))
  const runner = new LiveTestWorkerRunner({
    client: {
      async stepResult(_sessionId, payload) {
        results.push(payload)
      },
    },
    workerName: 'test-worker',
    browserFactory: async () => ({
      async newPage() {
        return page
      },
      async close() {
        return undefined
      },
    }),
    resolveScenarioSteps: async (scriptLine) => ({
      flow: [{
        id: 'open-step',
        resolvedId: 'open-step',
        interaction: {
          type: 'open',
          target: {
            url: String(scriptLine).includes('broken')
              ? 'https://example.test/broken'
              : 'https://example.test/recovered',
          },
        },
      }],
      video: { wait_between_steps: 0 },
      runtime: { step_timeout_ms: 30000 },
    }),
    runtimeRoot,
    testScriptConfig: {},
  })
  runner.sessionId = 'session-3'

  await runner.executeLeasedStep({
    liveTestId: 14,
    step: {
      id: 90,
      scriptLine: '<Oeffnen url="https://example.test/broken" />',
    },
  })

  assert.equal(results[0].status, 'failed')
  assert.equal(results[0].error.message, 'boom')
  assert.ok(runner.page)

  const existingPage = runner.page
  await runner.executeLeasedStep({
    liveTestId: 14,
    step: {
      id: 91,
      scriptLine: '<Oeffnen url="https://example.test/recovered" />',
    },
  })

  assert.equal(runner.page, existingPage)
  assert.equal(results[1].status, 'success')
  assert.deepEqual(page.gotoCalls, [
    'https://example.test/broken',
    'https://example.test/recovered',
  ])
})

test('runner re-registers after prolonged idle waits when session is not pinned', async () => {
  const calls = []
  let sessionCounter = 0
  const nextStepResponses = [
    { type: 'wait', liveTestId: null },
    { type: 'wait', liveTestId: null },
    { type: 'step', liveTestId: 44, step: { id: 12, position: 1, scriptLine: '<Oeffnen url="https://example.test/live" />' } },
    { type: 'release', reason: 'done' },
  ]
  const runner = new LiveTestWorkerRunner({
    client: {
      async register() {
        sessionCounter += 1
        const sessionId = `session-${sessionCounter}`
        calls.push(`register:${sessionId}`)
        return { sessionId, status: 'registered' }
      },
      async claimLiveTest(sessionId, liveTestId) {
        calls.push(`claim:${sessionId}:${liveTestId == null ? 'latest' : liveTestId}`)
        return { ok: true, liveTest: { id: 44, status: 'running', worker_session_id: sessionId } }
      },
      async nextStep(sessionId) {
        calls.push(`next:${sessionId}`)
        return nextStepResponses.shift() || { type: 'release', reason: 'done' }
      },
      async release(sessionId, reason) {
        calls.push(`release:${sessionId}:${reason}`)
      },
      async stepResult(sessionId, payload) {
        calls.push(`result:${sessionId}:${payload.status}`)
      },
    },
    workerName: 'test-worker',
    pollIntervalMs: 1,
    heartbeatIntervalMs: 60000,
    reRegisterAfterIdleMs: 5,
    sleepImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 6))
    },
    browserFactory: async () => ({
      async newPage() {
        return createFakePage()
      },
      async close() {
        return undefined
      },
    }),
    resolveScenarioSteps: async () => ({
      flow: [{
        id: 'open-step',
        resolvedId: 'open-step',
        interaction: {
          type: 'open',
          target: { url: 'https://example.test/live' },
        },
      }],
      video: { wait_between_steps: 0 },
      runtime: { step_timeout_ms: 30000 },
    }),
    testScriptConfig: {},
  })

  await runner.run()

  assert.deepEqual(calls, [
    'register:session-1',
    'claim:session-1:latest',
    'next:session-1',
    'next:session-1',
    'release:session-1:idle_timeout_reregister',
    'register:session-2',
    'claim:session-2:latest',
    'next:session-2',
    'result:session-2:success',
    'next:session-2',
    'release:session-2:done',
  ])
})

test('runner does not re-register after idle waits when session is pinned', async () => {
  const calls = []
  const runner = new LiveTestWorkerRunner({
    client: {
      async register() {
        calls.push('register')
        return { sessionId: 'session-fixed', status: 'registered' }
      },
      async claimLiveTest(sessionId, liveTestId) {
        calls.push(`claim:${sessionId}:${liveTestId == null ? 'latest' : liveTestId}`)
        return { ok: true, liveTest: { id: 55, status: 'running', worker_session_id: sessionId } }
      },
      async nextStep(sessionId) {
        calls.push(`next:${sessionId}`)
        return { type: 'release', reason: 'done' }
      },
      async release(sessionId, reason) {
        calls.push(`release:${sessionId}:${reason}`)
      },
    },
    workerName: 'test-worker',
    workerSessionId: 'fixed-session-id',
    reRegisterAfterIdleMs: 1,
  })

  await runner.run()

  assert.deepEqual(calls, [
    'register',
    'claim:session-fixed:latest',
    'next:session-fixed',
    'release:session-fixed:done',
  ])
})

test('runner claims explicit live test id after register when configured', async () => {
  const calls = []
  const runner = new LiveTestWorkerRunner({
    client: {
      async register() {
        calls.push('register')
        return { sessionId: 'session-claim', status: 'registered' }
      },
      async claimLiveTest(sessionId, liveTestId) {
        calls.push(`claim:${sessionId}:${liveTestId}`)
        return { ok: true, liveTest: { id: Number(liveTestId), status: 'running', worker_session_id: sessionId } }
      },
      async nextStep(sessionId) {
        calls.push(`next:${sessionId}`)
        return { type: 'release', reason: 'done' }
      },
      async release(sessionId, reason) {
        calls.push(`release:${sessionId}:${reason}`)
      },
    },
    workerName: 'test-worker',
    liveTestId: 77,
  })

  await runner.run()

  assert.deepEqual(calls, [
    'register',
    'claim:session-claim:77',
    'next:session-claim',
    'release:session-claim:done',
  ])
})

test('lunettes fragment fetch forwards Status default and Version to scenario endpoint', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'live-test-worker-'))
  const scenarioPath = join(runtimeRoot, 'source.xml')
  const xsdPath = join(process.cwd(), 'schemas', 'szenarioscript.xsd')
  const generatedSpecPath = join(runtimeRoot, 'generated.spec.js')
  const requests = []

  await writeFile(scenarioPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<SzenarioScript>',
    '  <Gruppe>',
    '    <Fragment name="frag-login" Version="2" />',
    '  </Gruppe>',
    '</SzenarioScript>',
    '',
  ].join('\n'), 'utf8')

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    requests.push(String(url))
    if (String(url).includes('/api/anfo/szenarien/by-fragment-id?')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([{
            id: 99,
            fragment_id: 'frag-login',
            szenario: '<?xml version="1.0" encoding="UTF-8"?><SzenarioScript id="123" fragment="true"><Gruppe /></SzenarioScript>',
          }])
        },
      }
    }
    if (String(url).includes('/api/anfo/szenario/123?')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            szenario: '<?xml version="1.0" encoding="UTF-8"?><SzenarioScript id="123" fragment="true"><Gruppe><Oeffnen url="https://example.test" /></Gruppe></SzenarioScript>',
          })
        },
      }
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const previousUsername = process.env.LUNETTES_API_USERNAME
  const previousPassword = process.env.LUNETTES_API_PASSWORD
  process.env.LUNETTES_API_USERNAME = 'user'
  process.env.LUNETTES_API_PASSWORD = 'pass'

  try {
    const resolved = await scenarioToSpecSource({
      scenarioPath,
      xsdPath,
      generatedSpecPath,
      centralConfig: {
        lunettes_api: {
          base_url: 'https://example.test',
        },
      },
      fragmentSource: 'lunettes',
    })

    assert.ok(resolved.resolvedRoot)
    assert.deepEqual(requests, [
      'https://example.test/api/anfo/szenarien/by-fragment-id?fragment_id=frag-login',
      'https://example.test/api/anfo/szenario/123?status=abgestimmt&version=2',
    ])
  } finally {
    globalThis.fetch = originalFetch
    if (previousUsername === undefined) {
      delete process.env.LUNETTES_API_USERNAME
    } else {
      process.env.LUNETTES_API_USERNAME = previousUsername
    }
    if (previousPassword === undefined) {
      delete process.env.LUNETTES_API_PASSWORD
    } else {
      process.env.LUNETTES_API_PASSWORD = previousPassword
    }
  }
})

test('fragment Auslesen exports final fragment runtime variable back to parent flow', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'live-test-worker-'))
  const scenarioPath = join(runtimeRoot, 'fragment-export.xml')
  const xsdPath = join(process.cwd(), 'schemas', 'szenarioscript.xsd')
  const generatedSpecPath = join(runtimeRoot, 'fragment-export.generated.spec.js')

  await writeFile(scenarioPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<SzenarioScript>',
    '  <Gruppe>',
    '    <Fragment name="frag-export">',
    '      <Auslesen variable="fragment.url" in-variable="parent.url" />',
    '    </Fragment>',
    '  </Gruppe>',
    '</SzenarioScript>',
    '',
  ].join('\n'), 'utf8')

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/anfo/szenarien/by-fragment-id?')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([{
            id: 100,
            fragment_id: 'frag-export',
            szenario: '<?xml version="1.0" encoding="UTF-8"?><SzenarioScript id="frag-export-root" fragment="true"><Gruppe><Oeffnen url="https://example.test/inside" /><Auslesen quelle="url" in-variable="fragment.url" /></Gruppe></SzenarioScript>',
          }])
        },
      }
    }
    if (String(url).includes('/api/anfo/szenario/frag-export-root?')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            szenario: '<?xml version="1.0" encoding="UTF-8"?><SzenarioScript id="frag-export-root" fragment="true"><Gruppe><Oeffnen url="https://example.test/inside" /><Auslesen quelle="url" in-variable="fragment.url" /></Gruppe></SzenarioScript>',
          })
        },
      }
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const previousUsername = process.env.LUNETTES_API_USERNAME
  const previousPassword = process.env.LUNETTES_API_PASSWORD
  process.env.LUNETTES_API_USERNAME = 'user'
  process.env.LUNETTES_API_PASSWORD = 'pass'

  try {
    const resolved = await scenarioToSpecSource({
      scenarioPath,
      xsdPath,
      generatedSpecPath,
      centralConfig: {
        lunettes_api: {
          base_url: 'https://example.test',
        },
      },
      fragmentSource: 'lunettes',
    })

    assert.equal(resolved.resolvedRoot.flow.length, 3)
    assert.equal(resolved.resolvedRoot.flow[0].interaction.type, 'open')
    assert.equal(resolved.resolvedRoot.flow[1].interaction.type, 'read-ui-value')
    assert.equal(resolved.resolvedRoot.flow[1].interaction.output, 'fragment.url')
    assert.equal(resolved.resolvedRoot.flow[2].interaction.type, 'set-runtime-variable')
    assert.equal(resolved.resolvedRoot.flow[2].interaction.output, 'parent.url')
    assert.equal(resolved.resolvedRoot.flow[2].interaction.value, '{{fragment.url}}')

    const page = createFakePage()
    const executionState = createScenarioExecutionState({
      page,
      testInfo: { outputPath: (filename) => filename },
      runtimeVariables: {},
    })
    const executionRuntime = createScenarioExecutionRuntime({
      page,
      waitBetweenStepsMs: 0,
      stepTimeoutMs: 30000,
    })

    await runPreparedScenarioFlow({
      steps: resolved.resolvedRoot.flow,
      executionRuntime,
      executionState,
    })

    assert.equal(resolveRuntimeTemplateString('{{parent.url}}', executionState.runtimeVariables), 'https://example.test/inside')
  } finally {
    globalThis.fetch = originalFetch
    if (previousUsername === undefined) {
      delete process.env.LUNETTES_API_USERNAME
    } else {
      process.env.LUNETTES_API_USERNAME = previousUsername
    }
    if (previousPassword === undefined) {
      delete process.env.LUNETTES_API_PASSWORD
    } else {
      process.env.LUNETTES_API_PASSWORD = previousPassword
    }
  }
})

test('PdfCodeAuslesen maps to extract-pdf-code interaction with german attributes', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'live-test-worker-'))
  const scenarioPath = join(runtimeRoot, 'pdf-code-auslesen.xml')
  const xsdPath = join(process.cwd(), 'schemas', 'szenarioscript.xsd')
  const generatedSpecPath = join(runtimeRoot, 'pdf-code-auslesen.generated.spec.js')

  await writeFile(scenarioPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<SzenarioScript>',
    '  <Gruppe>',
    '    <PdfCodeAuslesen regex="[A-Z0-9]{6}" zielvariable="pdf.code" pdf-pfad="temp/datei.pdf" />',
    '  </Gruppe>',
    '</SzenarioScript>',
    '',
  ].join('\n'), 'utf8')

  const resolved = await scenarioToSpecSource({
    scenarioPath,
    xsdPath,
    generatedSpecPath,
    centralConfig: {},
    fragmentSource: 'local',
  })

  assert.equal(resolved.resolvedRoot.flow.length, 1)
  assert.equal(resolved.resolvedRoot.flow[0].interaction.type, 'extract-pdf-code')
  assert.equal(resolved.resolvedRoot.flow[0].interaction.auslesenRegex, '[A-Z0-9]{6}')
  assert.equal(resolved.resolvedRoot.flow[0].interaction.output, 'pdf.code')
  assert.equal(resolved.resolvedRoot.flow[0].interaction.pdfPath, 'temp/datei.pdf')
})
