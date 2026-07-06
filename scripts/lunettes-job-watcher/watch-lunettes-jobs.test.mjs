import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'fs/promises'

import {
  assertManagedLiveTestWorkerHealthy,
  buildScenarioArtifactPlan,
  createManagedLiveTestWorkerState,
  getEffectiveJobPayload,
  noteManagedLiveTestWorkerExit,
  resolveScenarioInput,
  shouldStartManagedLiveTestWorker,
} from './watch-lunettes-jobs.mjs'

function createContext(overrides = {}) {
  return {
    liveTestWorkerEnabled: true,
    liveTestWorkerRestartBackoffMs: 5000,
    liveTestWorkerCrashWindowMs: 60000,
    liveTestWorkerMaxCrashCount: 3,
    liveTestWorkerMinUptimeMs: 10000,
    ...overrides,
  }
}

test('managed live-test worker restarts after non-fatal crash with backoff', () => {
  const context = createContext()
  const state = createManagedLiveTestWorkerState()

  state.child = { pid: 1 }
  state.currentRunStartedAtMs = 1000

  const exitInfo = noteManagedLiveTestWorkerExit(context, state, {
    code: 1,
    startedAtMs: 1000,
    exitedAtMs: 16000,
  })

  assert.equal(exitInfo.unexpected, true)
  assert.equal(state.fatalError, null)
  assert.equal(state.restartNotBeforeMs, 21000)
  assert.equal(shouldStartManagedLiveTestWorker(context, state, 20999), false)
  assert.equal(shouldStartManagedLiveTestWorker(context, state, 21000), true)
})

test('managed live-test worker becomes fatal after repeated crashes inside crash window', () => {
  const context = createContext({
    liveTestWorkerMaxCrashCount: 2,
    liveTestWorkerMinUptimeMs: 0,
  })
  const state = createManagedLiveTestWorkerState()

  noteManagedLiveTestWorkerExit(context, state, {
    code: 1,
    startedAtMs: 1000,
    exitedAtMs: 20000,
  })
  noteManagedLiveTestWorkerExit(context, state, {
    code: 1,
    startedAtMs: 30000,
    exitedAtMs: 45000,
  })

  assert.match(state.fatalError?.message || '', /Live-Test-Worker abgestuerzt/)
  assert.doesNotThrow(() => assertManagedLiveTestWorkerHealthy(context, state))
  assert.equal(shouldStartManagedLiveTestWorker(context, state, 50000), false)
})

test('managed live-test worker becomes fatal on immediate startup crash', () => {
  const context = createContext({
    liveTestWorkerMinUptimeMs: 10000,
  })
  const state = createManagedLiveTestWorkerState()

  noteManagedLiveTestWorkerExit(context, state, {
    code: 1,
    startedAtMs: 1000,
    exitedAtMs: 1500,
  })

  assert.match(state.fatalError?.message || '', /min_uptime_ms=10000/)
})

test('managed live-test worker can still fail the watcher when explicitly configured', () => {
  const context = createContext({
    liveTestWorkerFatalAffectsWatcher: true,
    liveTestWorkerMinUptimeMs: 10000,
  })
  const state = createManagedLiveTestWorkerState()

  noteManagedLiveTestWorkerExit(context, state, {
    code: 1,
    startedAtMs: 1000,
    exitedAtMs: 1500,
  })

  assert.throws(() => assertManagedLiveTestWorkerHealthy(context, state), /Live-Test-Worker abgestuerzt/)
})

test('videoscript artifact plan restores persistent testscript artifacts without legacy runs', () => {
  const plan = buildScenarioArtifactPlan({
    type: 'videoscript',
    szenario_id: '42',
    payload: {
      szenario_id: '42',
    },
  }, {
    scenarioMeta: {
      scenarioId: '42',
    },
  }, '7')

  assert.deepEqual(
    plan.restore.map((entry) => entry.artifactKey),
    ['testscript', 'videoscript'],
  )
  assert.deepEqual(
    plan.flush.map((entry) => entry.artifactKey),
    ['videoscript'],
  )
})

test('publish artifact plan uses only persistent artifacts', () => {
  const plan = buildScenarioArtifactPlan({
    type: 'publish',
    szenario_id: '42',
    payload: {
      szenario_id: '42',
    },
  }, {
    scenarioMeta: {
      scenarioId: '42',
    },
  }, '7')

  assert.deepEqual(
    plan.restore.map((entry) => entry.artifactKey),
    ['testscript', 'videoscript'],
  )
  assert.deepEqual(plan.flush, [])
})

test('publish scenario input falls back to Lunettes API when payload and cache are empty', async () => {
  const originalFetch = globalThis.fetch
  const scenarioId = 'watcher-api-fallback'
  const xml = '<?xml version="1.0" encoding="UTF-8"?><SzenarioScript id="api-source" titel="API Source"><Gruppe /></SzenarioScript>'
  const requestedUrls = []

  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url))
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({ szenario: xml })
      },
    }
  }

  try {
    const resolved = await resolveScenarioInput({
      id: 'test-api-fallback',
      type: 'publish',
      szenario_id: scenarioId,
      payload: {
        szenario_id: scenarioId,
      },
    }, '7', {
      baseUrl: 'https://lunettes.example.test',
      authHeader: 'Basic test',
    })

    assert.equal(resolved.source, 'lunettes-api')
    assert.match(requestedUrls[0], /\/api\/anfo\/szenario\/watcher-api-fallback\?version=7$/)
    assert.equal(await readFile(resolved.scenarioPath, 'utf8'), xml)
    assert.equal(resolved.scenarioMeta.scenarioId, 'api-source')
    assert.equal(resolved.scenarioMeta.scenarioVersion, '7')
  } finally {
    globalThis.fetch = originalFetch
    await rm(`neo/interactions/_lunettes-job-watcher/szenario-${scenarioId}`, { recursive: true, force: true })
  }
})

test('effective job payload keeps flat scenario version fields for generator jobs', () => {
  const payload = getEffectiveJobPayload({
    szenario_id: 52,
    szenario_version: 7,
    titel: 'Bewerbungsverfahren anlegen',
    software: 'NEO Niedersachsen',
    payload: {
      trigger: 'manual',
    },
  })

  assert.equal(payload.szenario_id, 52)
  assert.equal(payload.szenario_version, 7)
  assert.equal(payload.trigger, 'manual')
  assert.equal(payload.titel, 'Bewerbungsverfahren anlegen')
  assert.equal(payload.software, 'NEO Niedersachsen')
})
