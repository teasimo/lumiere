import { defineConfig } from '@playwright/test'

function buildRunScopedOutputDir() {
  const explicitOutputDir = String(process.env.SCENARIO_ARTIFACTS_DIR || '').trim()
  if (explicitOutputDir) {
    return explicitOutputDir
  }

  const runId = String(process.env.SCENARIO_RUN_ID || '').trim()
  return runId ? `temp/test-results/${runId}` : 'temp/test-results'
}

function buildRunScopedReportDir() {
  const explicitReportDir = String(process.env.SCENARIO_REPORT_DIR || '').trim()
  if (explicitReportDir) {
    return explicitReportDir
  }

  return 'temp/report'
}

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.js'],
  outputDir: buildRunScopedOutputDir(),
  reporter: [
    ['list'],
    ['html', { outputFolder: buildRunScopedReportDir(), open: 'never' }],
  ],
  use: {
    screenshot: 'on',
    video: 'on',
    trace: 'on',
  },
})
