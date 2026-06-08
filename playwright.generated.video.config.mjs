import { defineConfig } from '@playwright/test'

function buildRunScopedOutputDir() {
  const explicitOutputDir = String(process.env.SCENARIO_ARTIFACTS_DIR || '').trim()
  if (explicitOutputDir) {
    return explicitOutputDir
  }

  const runId = String(process.env.SCENARIO_RUN_ID || '').trim()
  return runId ? `temp/test-results/${runId}` : 'temp/test-results'
}

function parseVideoSize(rawValue) {
  const value = String(rawValue || '').trim()
  const match = value.match(/^(\d+)x(\d+)$/)
  if (!match) {
    return null
  }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }

  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  }
}

function parseScenarioTimeout() {
  const value = Number(process.env.SCENARIO_TEST_TIMEOUT_MS || 0)
  if (!Number.isFinite(value) || value <= 0) {
    return undefined
  }

  return Math.max(30000, Math.floor(value))
}

const parsedVideoSize = parseVideoSize(process.env.SCENARIO_VIDEO_SIZE)
const videoConfig = parsedVideoSize
  ? { mode: 'on', size: parsedVideoSize }
  : 'on'
const scenarioTimeout = parseScenarioTimeout()

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.js'],
  outputDir: buildRunScopedOutputDir(),
  timeout: scenarioTimeout,
  use: {
    video: videoConfig,
    trace: 'on',
  },
})
