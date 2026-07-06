import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertManagedLiveTestWorkerHealthy,
  buildScenarioArtifactPlan,
  createManagedLiveTestWorkerState,
  noteManagedLiveTestWorkerExit,
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
  assert.throws(() => assertManagedLiveTestWorkerHealthy(context, state), /Live-Test-Worker abgestuerzt/)
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
    ['scenario-cache', 'testscript', 'videoscript'],
  )
  assert.deepEqual(
    plan.flush.map((entry) => entry.artifactKey),
    ['scenario-cache', 'videogenerator', 'videoscript'],
  )
})
