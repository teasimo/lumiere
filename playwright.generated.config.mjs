import { defineConfig } from '@playwright/test'

function buildRunScopedOutputDir() {
  const explicitOutputDir = String(process.env.SCENARIO_ARTIFACTS_DIR || '').trim()
  if (explicitOutputDir) {
    return explicitOutputDir
  }

  const runId = String(process.env.SCENARIO_RUN_ID || '').trim()
  return runId ? `temp/test-results/${runId}` : 'temp/test-results'
}

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.js'],
  outputDir: buildRunScopedOutputDir(),
})
