#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const workspaceRoot = '/app'
const configPath = resolve(workspaceRoot, 'scenario.config.json')

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? { ...override } : override
  }

  const out = { ...base }
  if (!isPlainObject(override)) {
    return out
  }

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
      continue
    }
    out[key] = value
  }

  return out
}

function readConfig() {
  if (!existsSync(configPath)) {
    return {}
  }

  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw)
  if (isPlainObject(parsed?.scenario)) {
    return { scenario: parsed.scenario }
  }
  if (isPlainObject(parsed)) {
    return { scenario: parsed }
  }
  return { scenario: {} }
}

function parseIntegerEnv(name) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : null
}

function parseCsvEnv(name) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return null
  const values = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
  return values.length > 0 ? values : null
}

function parsePatchEnv() {
  const raw = String(process.env.SCENARIO_CONFIG_PATCH_JSON || '').trim()
  if (!raw) {
    return {}
  }

  const parsed = JSON.parse(raw)
  if (isPlainObject(parsed?.scenario)) {
    return parsed.scenario
  }
  return isPlainObject(parsed) ? parsed : {}
}

function buildEnvPatch() {
  const lunettesBaseUrl = String(process.env.LUNETTES_BASE_URL || process.env.WATCHER_BASE_URL || '').trim()
  const watcherTypes = parseCsvEnv('WATCHER_TYPES')
  const watcherWorkerId = String(process.env.WATCHER_WORKER_ID || '').trim()
  const watcherLeaseSeconds = parseIntegerEnv('WATCHER_LEASE_SECONDS')
  const watcherPollIntervalMs = parseIntegerEnv('WATCHER_POLL_INTERVAL_MS')
  const watcherTestscriptMode = String(process.env.WATCHER_TESTSCRIPT_MODE || '').trim()
  const watcherVideoProfile = String(process.env.WATCHER_VIDEO_PROFILE || '').trim()

  const patch = {
    'lunettes-job-watcher': {},
    'test-script': {
      lunettes_api: {},
    },
  }

  if (lunettesBaseUrl) {
    patch['lunettes-job-watcher'].base_url = lunettesBaseUrl
    patch['test-script'].lunettes_api.base_url = lunettesBaseUrl
  }

  if (watcherTypes) {
    patch['lunettes-job-watcher'].types = watcherTypes
  }

  if (watcherWorkerId) {
    patch['lunettes-job-watcher'].worker_id = watcherWorkerId
  }

  if (watcherLeaseSeconds !== null) {
    patch['lunettes-job-watcher'].lease_seconds = watcherLeaseSeconds
  }

  if (watcherPollIntervalMs !== null) {
    patch['lunettes-job-watcher'].poll_interval_ms = watcherPollIntervalMs
  }

  if (watcherTestscriptMode) {
    patch['lunettes-job-watcher'].testscript_mode = watcherTestscriptMode
  }

  if (watcherVideoProfile) {
    patch['lunettes-job-watcher'].video_profile = watcherVideoProfile
  }

  return patch
}

function pruneEmptyObjects(value) {
  if (Array.isArray(value)) {
    return value.map(pruneEmptyObjects)
  }

  if (!isPlainObject(value)) {
    return value
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key, pruneEmptyObjects(entryValue)])
    .filter(([, entryValue]) => {
      if (Array.isArray(entryValue)) return true
      if (!isPlainObject(entryValue)) return entryValue !== undefined
      return Object.keys(entryValue).length > 0
    })

  return Object.fromEntries(entries)
}

const current = readConfig()
const mergedScenario = deepMerge(
  deepMerge(current.scenario || {}, pruneEmptyObjects(buildEnvPatch())),
  parsePatchEnv(),
)

writeFileSync(configPath, `${JSON.stringify({ scenario: mergedScenario }, null, 2)}\n`, 'utf8')
console.log(`[azure-watcher-worker] scenario.config.json aktualisiert: ${configPath}`)
