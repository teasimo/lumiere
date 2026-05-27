#!/usr/bin/env node

import { cp, mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname, join, relative, resolve } from 'path'
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

function normalizeWorkspaceRelativePath(pathValue) {
  return String(pathValue || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
}

function sanitizeFileToken(value, fallback = 'unknown') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

function normalizeScenarioVersionForFolder(value) {
  let normalized = value

  if (typeof normalized === 'number' && Number.isFinite(normalized)) {
    if (Number.isInteger(normalized)) {
      normalized = `${normalized}.0`
    } else {
      normalized = String(normalized)
    }
  }

  const token = sanitizeFileToken(normalized || 'unknown', 'unknown')
  return token.replace(/\./g, '_')
}

function buildScenarioOutputFolderName({ scenarioId, scenarioVersion }) {
  const normalizedId = sanitizeFileToken(scenarioId || 'scenario', 'scenario')
  const normalizedVersion = normalizeScenarioVersionForFolder(scenarioVersion || 'unknown')
  return `${normalizedId}_v${normalizedVersion}`
}

async function collectArtifactDirs(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true })
  const dirs = []

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      dirs.push(fullPath)
      dirs.push(...await collectArtifactDirs(fullPath))
    }
  }

  return dirs
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readScenarioIdentity(scenarioAbsolutePath) {
  const fallbackId = sanitizeFileToken(basename(scenarioAbsolutePath, extname(scenarioAbsolutePath)), 'scenario')

  try {
    const raw = readFileSync(scenarioAbsolutePath, 'utf8')
    const parsed = parseYaml(raw) || {}
    const root = parsed.interaction || parsed || {}
    const scenarioId = sanitizeFileToken(root.id || fallbackId, fallbackId)
    const scenarioVersion = root.version ?? 'unknown'
    return { scenarioId, scenarioVersion }
  } catch {
    return { scenarioId: fallbackId, scenarioVersion: 'unknown' }
  }
}

function getResolvedYamlOutputPathFromSpec(specAbsolutePath) {
  if (specAbsolutePath.endsWith('.spec.js')) {
    return specAbsolutePath.slice(0, -'.spec.js'.length) + '.resolved.yaml'
  }
  return `${specAbsolutePath}.resolved.yaml`
}

async function findLatestScenarioVideoArtifacts({ artifactsRoot, scenarioPathRelative }) {
  if (!existsSync(artifactsRoot)) {
    return null
  }

  const normalizedScenarioPath = normalizeWorkspaceRelativePath(scenarioPathRelative)
  const dirs = [artifactsRoot, ...await collectArtifactDirs(artifactsRoot)]
  const candidates = []

  for (const dir of dirs) {
    const timelinePath = join(dir, 'yaml-step-timeline.json')
    const videoPath = join(dir, 'video.webm')
    const tracePath = join(dir, 'trace.zip')
    if (!existsSync(videoPath) || !existsSync(timelinePath)) {
      continue
    }

    const timeline = await readJsonIfExists(timelinePath)
    const sourcePath = normalizeWorkspaceRelativePath(timeline?.scenarioSource)
    if (sourcePath !== normalizedScenarioPath) {
      continue
    }

    const timelineStat = statSync(timelinePath)
    candidates.push({
      dir,
      timelinePath,
      videoPath,
      tracePath: existsSync(tracePath) ? tracePath : null,
      mtimeMs: timelineStat.mtimeMs,
    })
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0] || null
}

async function persistVideoRunArtifacts({ scenarioPath, specPath, mode }) {
  if (mode !== 'video') {
    return null
  }

  const scenarioAbsolutePath = resolve(workspaceRoot, scenarioPath)
  const scenarioPathRelative = relative(workspaceRoot, scenarioAbsolutePath)
  const specAbsolutePath = resolve(specPath)
  const specMetaPath = `${specAbsolutePath}.meta.json`
  const resolvedYamlPath = getResolvedYamlOutputPathFromSpec(specAbsolutePath)
  const artifactsRoot = resolve(workspaceRoot, 'temp', 'test-results')
  const latestArtifacts = await findLatestScenarioVideoArtifacts({
    artifactsRoot,
    scenarioPathRelative,
  })

  if (!latestArtifacts) {
    console.warn('[scenario-runner] No matching video artifacts found in temp/test-results for persistent output export.')
    return null
  }

  const { scenarioId, scenarioVersion } = readScenarioIdentity(scenarioAbsolutePath)
  const scenarioFolderName = buildScenarioOutputFolderName({ scenarioId, scenarioVersion })
  const targetRoot = resolve(workspaceRoot, 'output', scenarioFolderName)
  const targetArtifactsDir = join(targetRoot, 'artifacts')
  const targetSpecsDir = join(targetRoot, 'generated')

  await mkdir(targetRoot, { recursive: true })
  await mkdir(targetArtifactsDir, { recursive: true })
  await mkdir(targetSpecsDir, { recursive: true })

  await cp(latestArtifacts.dir, targetArtifactsDir, { recursive: true, force: true })
  await cp(specAbsolutePath, join(targetSpecsDir, basename(specAbsolutePath)), { force: true })
  if (existsSync(specMetaPath)) {
    await cp(specMetaPath, join(targetSpecsDir, basename(specMetaPath)), { force: true })
  }
  await cp(scenarioAbsolutePath, join(targetRoot, basename(scenarioAbsolutePath)), { force: true })
  if (existsSync(resolvedYamlPath)) {
    await cp(resolvedYamlPath, join(targetRoot, basename(resolvedYamlPath)), { force: true })
  } else {
    console.warn(`[scenario-runner] Resolved YAML not found for export: ${relative(workspaceRoot, resolvedYamlPath)}`)
  }

  const runMetaPath = join(targetRoot, 'run-meta.json')
  await writeFile(runMetaPath, JSON.stringify({
    createdAtIso: new Date().toISOString(),
    scenario: {
      id: scenarioId,
      version: scenarioVersion,
      outputFolder: scenarioFolderName,
      sourcePathRelative: scenarioPathRelative,
    },
    generatedSpec: {
      sourcePathRelative: relative(workspaceRoot, specAbsolutePath),
      metaPathRelative: existsSync(specMetaPath) ? relative(workspaceRoot, specMetaPath) : null,
      resolvedYamlPathRelative: existsSync(resolvedYamlPath) ? relative(workspaceRoot, resolvedYamlPath) : null,
    },
    exportedTo: {
      rootRelative: relative(workspaceRoot, targetRoot),
      artifactsRelative: relative(workspaceRoot, targetArtifactsDir),
      generatedRelative: relative(workspaceRoot, targetSpecsDir),
    },
    sourceArtifactsDirRelative: relative(workspaceRoot, latestArtifacts.dir),
  }, null, 2), 'utf8')

  return {
    scenarioId,
    scenarioVersion,
    scenarioFolderName,
    outputRoot: targetRoot,
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

function buildScenarioRunId() {
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}-${ms}`
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
  const scenarioRunId = buildScenarioRunId()

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
      SCENARIO_RUN_ID: scenarioRunId,
    }
  )
}

async function main() {
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

  const persistedArtifacts = await persistVideoRunArtifacts({
    scenarioPath: options.scenarioPath,
    specPath,
    mode: options.mode,
  })

  if (persistedArtifacts) {
    console.log(`[scenario-runner] Exported run artifacts to ${relative(workspaceRoot, persistedArtifacts.outputRoot)}`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
