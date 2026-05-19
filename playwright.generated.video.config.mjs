import { defineConfig } from '@playwright/test'

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

const parsedVideoSize = parseVideoSize(process.env.SCENARIO_VIDEO_SIZE)
const videoConfig = parsedVideoSize
  ? { mode: 'on', size: parsedVideoSize }
  : 'on'

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.js'],
  outputDir: 'temp/test-results',
  use: {
    video: videoConfig,
  },
})
