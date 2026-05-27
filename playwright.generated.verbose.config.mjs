import { defineConfig } from '@playwright/test'

function buildRunScopedOutputDir() {
  const runId = String(process.env.SCENARIO_RUN_ID || '').trim()
  return runId ? `temp/test-results/${runId}` : 'temp/test-results'
}

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.js'],
  outputDir: buildRunScopedOutputDir(),
  reporter: [
    ['list'],
    ['html', { outputFolder: 'temp/report', open: 'never' }],
  ],
  use: {
    screenshot: 'on',
    video: 'on',
    trace: 'on',
  },
})
