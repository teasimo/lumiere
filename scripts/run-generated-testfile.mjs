#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname, relative, resolve } from 'path'
import { spawnSync } from 'child_process'
import { parse as parseYaml } from 'yaml'
import { loadCentralConfig } from './shared/central-config.mjs'

const workspaceRoot = process.cwd()
const fallbackScenarioPath = 'lunettes/tests/login.yaml'
const fallbackOutputDir = 'temp/testfiles'

function printUsage() {
  console.log([
    'Usage:',
    '  npm run check:testfile -- [<scenario-yaml>] [--force] [--out-dir <path>] [-- <playwright-args>]',
    '  npm run run:testfile:video -- [<scenario-yaml>] [--force] [--out-dir <path>] [-- <playwright-args>]',
    '',
    'Examples:',
    '  npm run check:testfile -- lunettes/tests/login.yaml',
    '  npm run check:testfile:force -- lunettes/tests/login.yaml',
    '  npm run run:testfile:video -- lunettes/tests/login.yaml',
    '  npm run run:testfile:video -- lunettes/tests/login.yaml -- --project=chromium',
  ].join('\n'))
}

function parseArgs(argv) {
  const args = [...argv]
  const options = {
    scenarioPath: null,
    force: false,
    mode: 'check',
    outDir: null,
    verbose: false,
    playwrightArgs: [],
  }

  let passthrough = false
  while (args.length > 0) {
    const token = args.shift()

    if (passthrough) {
      options.playwrightArgs.push(token)
      continue
    }

    if (token === '--') {
      passthrough = true
      continue
    }

    if (token === '--help' || token === '-h') {
      options.help = true
      return options
    }

    if (token === '--force') {
      options.force = true
      continue
    }

    if (token === '--verbose') {
      options.verbose = true
      continue
    }

    if (token === '--mode') {
      const mode = String(args.shift() || '').trim()
      if (mode !== 'check' && mode !== 'video') {
        throw new Error('Unknown mode. Allowed: check, video')
      }
      options.mode = mode
      continue
    }

    if (token === '--out-dir') {
      options.outDir = args.shift() || null
      continue
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`)
    }

    if (options.scenarioPath) {
      throw new Error('Only one scenario yaml path is supported.')
    }
    options.scenarioPath = token
  }

  return options
}

function applyConfigDefaults(options, centralConfig) {
  const defaults = centralConfig?.defaults || {}

  return {
    ...options,
    scenarioPath: options.scenarioPath || defaults.scenario_path || fallbackScenarioPath,
    outDir: options.outDir || defaults.output_dir || fallbackOutputDir,
  }
}

function runCommand(command, commandArgs, errorMessage, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: workspaceRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  })

  if ((result.status ?? 1) !== 0) {
    throw new Error(errorMessage)
  }
}

function formatIso(value) {
  return new Date(value).toISOString()
}

function warnIfGeneratedSpecIsStale({ scenarioAbsolute, outputSpecAbsolute }) {
  const metaPath = `${outputSpecAbsolute}.meta.json`
  const scenarioMtimeMs = statSync(scenarioAbsolute).mtimeMs

  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      const builtFromYamlMtimeMs = Number(meta.sourceYamlMtimeMs || 0)

      if (Number.isFinite(builtFromYamlMtimeMs) && scenarioMtimeMs > builtFromYamlMtimeMs) {
        console.warn(`[scenario-runner] WARNING: YAML is newer than generated temp spec.`)
        console.warn(`[scenario-runner] YAML mtime : ${formatIso(scenarioMtimeMs)}`)
        console.warn(`[scenario-runner] Built mtime: ${formatIso(builtFromYamlMtimeMs)}`)
        console.warn('[scenario-runner] Run with --force to regenerate before execution.')
      }
      return
    } catch {
      console.warn(`[scenario-runner] WARNING: Could not parse metadata file ${relative(workspaceRoot, metaPath)}.`)
    }
  }

  const specMtimeMs = statSync(outputSpecAbsolute).mtimeMs
  if (scenarioMtimeMs > specMtimeMs) {
    console.warn('[scenario-runner] WARNING: YAML appears newer than generated temp spec (fallback mtime check).')
    console.warn(`[scenario-runner] YAML mtime: ${formatIso(scenarioMtimeMs)}`)
    console.warn(`[scenario-runner] Spec mtime: ${formatIso(specMtimeMs)}`)
    console.warn('[scenario-runner] Run with --force to regenerate before execution.')
  }
}

function ensureGeneratedSpec({ scenarioPath, outDir, force }) {
  const scenarioAbsolute = resolve(workspaceRoot, scenarioPath)
  const outputDirAbsolute = resolve(workspaceRoot, outDir)
  const outputFileName = `${basename(scenarioAbsolute, extname(scenarioAbsolute))}.spec.js`
  const outputSpecAbsolute = resolve(outputDirAbsolute, outputFileName)

  if (!existsSync(scenarioAbsolute)) {
    throw new Error(`Scenario file not found: ${relative(workspaceRoot, scenarioAbsolute)}`)
  }

  const shouldGenerate = force || !existsSync(outputSpecAbsolute)
  if (shouldGenerate) {
    console.log(`Generating temp spec from ${relative(workspaceRoot, scenarioAbsolute)} ...`)
    runCommand(
      'node',
      ['scripts/generate-tests-from-scenario.mjs', relative(workspaceRoot, scenarioAbsolute), '--out-dir', relative(workspaceRoot, outputDirAbsolute)],
      'Failed to generate temp spec file.'
    )
  } else {
    console.log(`Using existing temp spec: ${relative(workspaceRoot, outputSpecAbsolute)}`)
    warnIfGeneratedSpecIsStale({ scenarioAbsolute, outputSpecAbsolute })
  }

  if (!existsSync(outputSpecAbsolute)) {
    throw new Error(`Expected generated spec does not exist: ${relative(workspaceRoot, outputSpecAbsolute)}`)
  }

  return outputSpecAbsolute
}

function normalizeResolution(value) {
  const width = Number(value?.width)
  const height = Number(value?.height)

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }

  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  }
}

function readVideoConfigFromScenario(scenarioAbsolutePath, centralConfig) {
  const fallbackResolution = normalizeResolution(centralConfig?.video?.resolution)

  try {
    const raw = readFileSync(scenarioAbsolutePath, 'utf8')
    const parsed = parseYaml(raw) || {}
    const root = parsed.interaction || parsed
    const scenarioResolution = normalizeResolution(root?.video?.resolution)

    if (scenarioResolution) {
      return {
        resolution: scenarioResolution,
        source: 'scenario',
      }
    }

    if (fallbackResolution) {
      return {
        resolution: fallbackResolution,
        source: 'central-config',
      }
    }

    return { resolution: null, source: 'none' }
  } catch {
    if (fallbackResolution) {
      return {
        resolution: fallbackResolution,
        source: 'central-config',
      }
    }
    return { resolution: null, source: 'none' }
  }
}

function runPlaywright(specAbsolutePath, playwrightArgs, mode, scenarioPath, centralConfig, verbose = false) {
  const specRelative = relative(workspaceRoot, specAbsolutePath)
  const configFile = mode === 'video'
    ? 'playwright.generated.video.config.mjs'
    : verbose
      ? 'playwright.generated.verbose.config.mjs'
      : 'playwright.generated.config.mjs'
  const scenarioAbsolutePath = resolve(workspaceRoot, scenarioPath)
  const videoConfig = readVideoConfigFromScenario(scenarioAbsolutePath, centralConfig)
  const videoSizeEnv = videoConfig.resolution
    ? `${videoConfig.resolution.width}x${videoConfig.resolution.height}`
    : ''

  if (mode === 'video' && videoConfig.resolution) {
    const sourceLabel = videoConfig.source === 'scenario' ? 'YAML' : 'central config'
    console.log(`Video resolution from ${sourceLabel}: ${videoConfig.resolution.width}x${videoConfig.resolution.height}`)
  }

  console.log(`Running Playwright test: ${specRelative}`)

  runCommand(
    'npx',
    ['playwright', 'test', '--config', configFile, specRelative, ...playwrightArgs],
    'Playwright test execution failed.',
    {
      ...process.env,
      SCENARIO_VIDEO_MODE: mode === 'video' ? '1' : '0',
      SCENARIO_VIDEO_SIZE: videoSizeEnv,
    }
  )
}

function main() {
  const central = loadCentralConfig(workspaceRoot)
  const rawOptions = parseArgs(process.argv.slice(2))
  const options = applyConfigDefaults(rawOptions, central.config)
  if (options.help) {
    printUsage()
    return
  }

  const specPath = ensureGeneratedSpec({
    scenarioPath: options.scenarioPath,
    outDir: options.outDir,
    force: options.force || options.verbose,
  })

  const playwrightArgs = options.playwrightArgs

  runPlaywright(specPath, playwrightArgs, options.mode, options.scenarioPath, central.config, options.verbose)
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
