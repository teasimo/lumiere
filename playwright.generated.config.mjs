import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.js'],
  outputDir: 'temp/test-results',
})
