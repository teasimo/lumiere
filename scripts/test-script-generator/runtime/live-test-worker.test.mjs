import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createScenarioExecutionRuntime,
  createScenarioExecutionState,
  runPreparedScenarioFlow,
} from './scenario-helpers.mjs'
import { LiveTestWorkerRunner, normalizeScriptLineToScenarioXml } from './live-test-worker.mjs'

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
