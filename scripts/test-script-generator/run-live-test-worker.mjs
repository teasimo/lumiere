#!/usr/bin/env node

import { hostname } from 'os'
import { resolve } from 'path'
import { loadCentralConfig, getTestScriptConfig } from '../shared/central-config.mjs'
import { LiveTestWorkerRunner, LunettesLiveTestClient } from './runtime/live-test-worker.mjs'

const workspaceRoot = process.cwd()

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/test-script-generator/run-live-test-worker.mjs [--worker-name <name>] [--session-id <id>] [--poll-interval-ms <ms>] [--heartbeat-interval-ms <ms>] [--software <name>]',
    '',
    'Environment:',
    '  LUNETTES_API_USERNAME',
    '  LUNETTES_API_PASSWORD',
  ].join('\n'))
}

function parseArgs(argv) {
  const args = [...argv]
  const options = {
    workerName: '',
    sessionId: '',
    pollIntervalMs: null,
    heartbeatIntervalMs: null,
    software: null,
  }

  while (args.length > 0) {
    const token = args.shift()

    if (token === '--help' || token === '-h') {
      options.help = true
      return options
    }
    if (token === '--worker-name') {
      options.workerName = args.shift() || ''
      continue
    }
    if (token.startsWith('--worker-name=')) {
      options.workerName = token.slice('--worker-name='.length)
      continue
    }
    if (token === '--session-id') {
      options.sessionId = args.shift() || ''
      continue
    }
    if (token.startsWith('--session-id=')) {
      options.sessionId = token.slice('--session-id='.length)
      continue
    }
    if (token === '--poll-interval-ms') {
      options.pollIntervalMs = args.shift() || null
      continue
    }
    if (token.startsWith('--poll-interval-ms=')) {
      options.pollIntervalMs = token.slice('--poll-interval-ms='.length)
      continue
    }
    if (token === '--heartbeat-interval-ms') {
      options.heartbeatIntervalMs = args.shift() || null
      continue
    }
    if (token.startsWith('--heartbeat-interval-ms=')) {
      options.heartbeatIntervalMs = token.slice('--heartbeat-interval-ms='.length)
      continue
    }
    if (token === '--software') {
      options.software = args.shift() || null
      continue
    }
    if (token.startsWith('--software=')) {
      options.software = token.slice('--software='.length)
      continue
    }

    throw new Error(`Unknown option: ${token}`)
  }

  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const central = loadCentralConfig(workspaceRoot, { software: options.software })
  const testScriptConfig = getTestScriptConfig(central.config)
  const liveTestConfig = central.config?.['live-test-worker'] || {}
  const baseUrl = String(liveTestConfig.base_url || central.config?.['lunettes-job-watcher']?.base_url || testScriptConfig?.lunettes_api?.base_url || '').trim()
  const username = String(process.env.LUNETTES_API_USERNAME || '').trim()
  const password = String(process.env.LUNETTES_API_PASSWORD || '')

  if (!baseUrl) {
    throw new Error('Lunettes base_url fehlt. Erwartet: scenario["live-test-worker"].base_url oder watcher/test-script base_url.')
  }
  if (!username || !password) {
    throw new Error('LUNETTES_API_USERNAME oder LUNETTES_API_PASSWORD fehlt.')
  }

  const workerName = String(options.workerName || liveTestConfig.worker_name || `playwright-live-test-worker@${hostname()}`).trim()
  const runner = new LiveTestWorkerRunner({
    client: new LunettesLiveTestClient({ baseUrl, username, password }),
    workerName,
    workerSessionId: String(options.sessionId || liveTestConfig.worker_session_id || '').trim() || null,
    pollIntervalMs: Number(options.pollIntervalMs ?? liveTestConfig.poll_interval_ms ?? 1000),
    heartbeatIntervalMs: Number(options.heartbeatIntervalMs ?? liveTestConfig.heartbeat_interval_ms ?? 30000),
    runtimeRoot: resolve(workspaceRoot, 'temp', 'live-test-workers'),
    xsdPath: resolve(workspaceRoot, 'schemas', 'szenarioscript.xsd'),
    testScriptConfig,
    fragmentSource: 'lunettes',
  })

  console.log(`[live-test-worker] start worker_name=${workerName} base_url=${baseUrl}`)
  await runner.run()
}

main().catch((error) => {
  console.error(`[live-test-worker] ${error.message}`)
  process.exitCode = 1
})
