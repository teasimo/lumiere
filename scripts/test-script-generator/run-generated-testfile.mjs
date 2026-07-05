#!/usr/bin/env node

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { spawnSync } from 'child_process'
import { getTestScriptConfig, loadCentralConfig } from '../shared/central-config.mjs'
import { buildScenarioOutputRoot, sanitizeScenarioOutputToken } from '../shared/scenario-output.mjs'
import { resolveFragmentSourceForScenario } from '../shared/lunettes-fragment-source.mjs'
import { buildScenarioXmlGeneratorInvocation } from '../shared/scenario-xml-generator.mjs'

const workspaceRoot = process.cwd()
const fallbackScenarioPath = 'neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml'
const fallbackOutputDir = 'temp/testfiles'
function printUsage() {
  console.log([
    'Usage:',
    '  npm run check:testfile -- [<scenario-xml>] --scenario-id <id> [--software <name>] [--force] [--out-dir <path>] [-- <playwright-args>]',
    '  npm run run:testfile-script -- [<scenario-xml>] --scenario-id <id> [--software <name>] [--force] [--out-dir <path>] [-- <playwright-args>]',
    '',
    'Examples:',
    '  npm run check:testfile -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml --scenario-id 123',
    '  npm run check:testfile:force -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml --scenario-id 123',
    '  npm run run:testfile-script -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml --scenario-id 123',
    '  npm run run:testfile-script -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml --scenario-id 123 -- --project=chromium',
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
    scenarioId: null,
    fragmentSource: 'lunettes',
    software: null,
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

    if (token === '--scenario-id') {
      options.scenarioId = args.shift() || null
      continue
    }

    if (token.startsWith('--scenario-id=')) {
      options.scenarioId = token.slice('--scenario-id='.length)
      continue
    }

    if (token === '--fragment-source') {
      options.fragmentSource = args.shift() || null
      continue
    }

    if (token.startsWith('--fragment-source=')) {
      options.fragmentSource = token.slice('--fragment-source='.length)
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

    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`)
    }

    if (options.scenarioPath) {
      throw new Error('Only one scenario xml path is supported.')
    }
    options.scenarioPath = token
  }

  return options
}

function applyConfigDefaults(options, centralConfig) {
  const defaults = centralConfig?.defaults || {}

  return {
    ...options,
    scenarioPath: options.scenarioPath || defaults.scenario_path_xml || defaults.scenario_path || fallbackScenarioPath,
    outDir: options.outDir || defaults.output_dir || fallbackOutputDir,
    fragmentSource: resolveFragmentSourceForScenario(
      options.fragmentSource,
      options.scenarioPath || defaults.scenario_path_xml || defaults.scenario_path || fallbackScenarioPath,
      'lunettes',
    ),
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
  return sanitizeScenarioOutputToken(value, fallback)
}

function parseRequiredScenarioId(value) {
  const scenarioId = sanitizeFileToken(value, '')
  if (!scenarioId) {
    throw new Error('Scenario-ID fehlt. Erwartet: --scenario-id <id>')
  }
  return scenarioId
}

function countRenderedFlowSteps(flowEntries) {
  let count = 0

  for (const step of flowEntries || []) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      continue
    }

    count += 1

    const interactionType = String(step?.interaction?.type || '').trim().toLowerCase()
    const target = step?.interaction?.target || {}
    const hasUsableScrollTarget = Boolean(
      target?.testid || target?.id || target?.['data-id'] || target?.text || target?.class || Object.keys(target || {}).some((key) => (
        !['testid', 'id', 'data-id', 'text', 'role', 'url', 'state', 'click_child_selector', 'treffer-index', 'selektor-regex', 'label', 'aria-label', 'class', 'komponententyp'].includes(key)
        && target[key] != null
      ))
    )
    if (['click', 'fill', 'append', 'replace', 'select', 'upload', 'search-and-select'].includes(interactionType) && hasUsableScrollTarget) {
      count += 1
    }

    if (Array.isArray(step.flow) && step.flow.length > 0) {
      count += countRenderedFlowSteps(step.flow)
    }

    if (Array.isArray(step.elseFlow) && step.elseFlow.length > 0) {
      count += countRenderedFlowSteps(step.elseFlow)
    }
  }

  return count
}

function resolveScenarioTestTimeoutMs(specAbsolutePath) {
  const siblingPaths = getGeneratedSiblingPathsFromSpec(specAbsolutePath)
  if (!existsSync(siblingPaths.resolvedJsonPath)) {
    return 30000
  }

  try {
    const raw = readFileSync(siblingPaths.resolvedJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    const scenarioRoot = parsed?.interaction || parsed || {}
    const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
    const waitBetweenStepsMs = Math.max(0, Math.floor(Number(scenarioRoot?.video?.wait_between_steps ?? 0) || 0))
    const renderedStepCount = Math.max(1, countRenderedFlowSteps(flow))
    const actionBudgetMs = renderedStepCount * 3500
    const pacingBudgetMs = renderedStepCount * waitBetweenStepsMs
    return Math.max(30000, actionBudgetMs + pacingBudgetMs + 10000)
  } catch {
    return 30000
  }
}

function getGeneratedSiblingPathsFromSpec(specAbsolutePath) {
  const specDir = dirname(specAbsolutePath)
  if (specAbsolutePath.endsWith('.spec.js')) {
    const stem = specAbsolutePath.slice(0, -'.spec.js'.length)
    return {
      specPath: specAbsolutePath,
      specMetaPath: `${specAbsolutePath}.meta.json`,
      scenarioHelpersPath: join(specDir, 'scenario-helpers.mjs'),
      envFillStrategiesPath: `${stem}.env-fill-strategies.mjs`,
      scenarioRuntimePath: join(specDir, 'generated-scenario-runtime.js'),
      centralFillStrategiesPath: join(specDir, 'central-fill-strategies.mjs'),
      extractPdfCodePath: join(specDir, 'extract-pdf-code.mjs'),
      resolvedXmlPath: `${stem}.test-resolved.xml`,
      resolvedJsonPath: `${stem}.resolved.json`,
    }
  }

  return {
    specPath: specAbsolutePath,
    specMetaPath: `${specAbsolutePath}.meta.json`,
    scenarioHelpersPath: join(specDir, 'scenario-helpers.mjs'),
    envFillStrategiesPath: `${specAbsolutePath}.env-fill-strategies.mjs`,
    scenarioRuntimePath: join(specDir, 'generated-scenario-runtime.js'),
    centralFillStrategiesPath: join(specDir, 'central-fill-strategies.mjs'),
    extractPdfCodePath: join(specDir, 'extract-pdf-code.mjs'),
    resolvedXmlPath: `${specAbsolutePath}.test-resolved.xml`,
    resolvedJsonPath: `${specAbsolutePath}.resolved.json`,
  }
}

async function persistScenarioRunArtifacts({
  scenarioPath,
  specPath,
  runRoot,
  artifactsDir,
  mode,
  status,
  scenarioRunId,
  playwrightExitCode,
}) {
  const scenarioAbsolutePath = resolve(workspaceRoot, scenarioPath)
  const scenarioPathRelative = relative(workspaceRoot, scenarioAbsolutePath)
  const specAbsolutePath = resolve(specPath)
  const generatedSiblingPaths = getGeneratedSiblingPathsFromSpec(specAbsolutePath)
  const specMetaPath = generatedSiblingPaths.specMetaPath
  const scenarioHelpersPath = generatedSiblingPaths.scenarioHelpersPath
  const envFillStrategiesPath = generatedSiblingPaths.envFillStrategiesPath
  const scenarioRuntimePath = generatedSiblingPaths.scenarioRuntimePath
  const centralFillStrategiesPath = generatedSiblingPaths.centralFillStrategiesPath
  const extractPdfCodePath = generatedSiblingPaths.extractPdfCodePath
  const resolvedXmlPath = generatedSiblingPaths.resolvedXmlPath
  const resolvedJsonPath = generatedSiblingPaths.resolvedJsonPath
  const targetRoot = runRoot
  const targetArtifactsDir = artifactsDir
  const targetSpecsDir = join(targetRoot, 'generated')

  await mkdir(targetRoot, { recursive: true })
  await mkdir(targetArtifactsDir, { recursive: true })
  await mkdir(targetSpecsDir, { recursive: true })

  await cp(specAbsolutePath, join(targetSpecsDir, basename(specAbsolutePath)), { force: true })
  if (existsSync(specMetaPath)) {
    await cp(specMetaPath, join(targetSpecsDir, basename(specMetaPath)), { force: true })
  }
  if (existsSync(scenarioHelpersPath)) {
    await cp(scenarioHelpersPath, join(targetSpecsDir, basename(scenarioHelpersPath)), { force: true })
  }
  if (existsSync(envFillStrategiesPath)) {
    await cp(envFillStrategiesPath, join(targetSpecsDir, basename(envFillStrategiesPath)), { force: true })
  }
  if (existsSync(scenarioRuntimePath)) {
    await cp(scenarioRuntimePath, join(targetSpecsDir, basename(scenarioRuntimePath)), { force: true })
  }
  if (existsSync(centralFillStrategiesPath)) {
    await cp(centralFillStrategiesPath, join(targetSpecsDir, basename(centralFillStrategiesPath)), { force: true })
  }
  if (existsSync(extractPdfCodePath)) {
    await cp(extractPdfCodePath, join(targetSpecsDir, basename(extractPdfCodePath)), { force: true })
  }
  await cp(scenarioAbsolutePath, join(targetRoot, basename(scenarioAbsolutePath)), { force: true })
  if (existsSync(resolvedXmlPath)) {
    await cp(resolvedXmlPath, join(targetRoot, basename(resolvedXmlPath)), { force: true })
  } else {
    console.warn(`[scenario-runner] Resolved XML not found for export: ${relative(workspaceRoot, resolvedXmlPath)}`)
  }
  if (existsSync(resolvedJsonPath)) {
    await cp(resolvedJsonPath, join(targetRoot, basename(resolvedJsonPath)), { force: true })
  } else {
    console.warn(`[scenario-runner] Resolved JSON not found for export: ${relative(workspaceRoot, resolvedJsonPath)}`)
  }

  const runMetaPath = join(targetRoot, 'run-meta.json')
  await writeFile(runMetaPath, JSON.stringify({
    createdAtIso: new Date().toISOString(),
    mode,
    status,
    scenarioRunId,
    playwrightExitCode,
    scenario: {
      sourcePathRelative: scenarioPathRelative,
      outputFolder: relative(workspaceRoot, dirname(targetRoot)),
      runRootRelative: relative(workspaceRoot, targetRoot),
      artifactsDirRelative: relative(workspaceRoot, targetArtifactsDir),
      sourcePathNormalized: normalizeWorkspaceRelativePath(scenarioPathRelative),
    },
    generatedSpec: {
      sourcePathRelative: relative(workspaceRoot, specAbsolutePath),
      metaPathRelative: existsSync(specMetaPath) ? relative(workspaceRoot, specMetaPath) : null,
      resolvedXmlPathRelative: existsSync(resolvedXmlPath) ? relative(workspaceRoot, resolvedXmlPath) : null,
      resolvedJsonPathRelative: existsSync(resolvedJsonPath) ? relative(workspaceRoot, resolvedJsonPath) : null,
    },
    exportedTo: {
      rootRelative: relative(workspaceRoot, targetRoot),
      artifactsRelative: relative(workspaceRoot, targetArtifactsDir),
      generatedRelative: relative(workspaceRoot, targetSpecsDir),
    },
  }, null, 2), 'utf8')

  return {
    outputRoot: targetRoot,
  }
}

async function pruneScenarioRuns({ scenarioRoot }) {
  const runsRoot = join(scenarioRoot, 'runs')
  if (!existsSync(runsRoot)) {
    return { removedRunRoots: [] }
  }

  const runEntries = await readdir(runsRoot, { withFileTypes: true })
  const runs = []

  for (const entry of runEntries) {
    if (!entry.isDirectory()) {
      continue
    }

    const runRoot = join(runsRoot, entry.name)
    const runMetaPath = join(runRoot, 'run-meta.json')
    if (!existsSync(runMetaPath)) {
      continue
    }

    try {
      const raw = await readFile(runMetaPath, 'utf8')
      const parsed = JSON.parse(raw)
      runs.push({
        runRoot,
        status: String(parsed?.status || '').trim().toLowerCase(),
        createdAtIso: String(parsed?.createdAtIso || '').trim(),
        scenarioRunId: String(parsed?.scenarioRunId || entry.name).trim() || entry.name,
      })
    } catch {
      console.warn(`[scenario-runner] Could not parse run metadata: ${relative(workspaceRoot, runMetaPath)}`)
    }
  }

  const sortNewestFirst = (left, right) => {
    const leftTime = Date.parse(left.createdAtIso)
    const rightTime = Date.parse(right.createdAtIso)
    const normalizedLeftTime = Number.isFinite(leftTime) ? leftTime : -Infinity
    const normalizedRightTime = Number.isFinite(rightTime) ? rightTime : -Infinity
    if (normalizedLeftTime !== normalizedRightTime) {
      return normalizedRightTime - normalizedLeftTime
    }
    return right.scenarioRunId.localeCompare(left.scenarioRunId)
  }

  const passedRuns = runs
    .filter((run) => run.status === 'passed')
    .sort(sortNewestFirst)
  const failedRuns = runs
    .filter((run) => run.status === 'failed')
    .sort(sortNewestFirst)

  const keepRoots = new Set()
  if (passedRuns[0]) {
    keepRoots.add(passedRuns[0].runRoot)
  }
  if (failedRuns[0]) {
    keepRoots.add(failedRuns[0].runRoot)
  }

  const removedRunRoots = []
  for (const run of runs) {
    if (keepRoots.has(run.runRoot)) {
      continue
    }

    await rm(run.runRoot, { recursive: true, force: true })
    removedRunRoots.push(run.runRoot)
  }

  return { removedRunRoots }
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
      const builtFromXmlMtimeMs = Number(meta.sourceXmlMtimeMs || 0)

      if (Number.isFinite(builtFromXmlMtimeMs) && scenarioMtimeMs > builtFromXmlMtimeMs) {
        console.warn('[scenario-runner] WARNING: XML is newer than generated temp spec.')
        console.warn(`[scenario-runner] XML mtime : ${formatIso(scenarioMtimeMs)}`)
        console.warn(`[scenario-runner] Built mtime: ${formatIso(builtFromXmlMtimeMs)}`)
        console.warn('[scenario-runner] Run with --force to regenerate before execution.')
      }
      return
    } catch {
      console.warn(`[scenario-runner] WARNING: Could not parse metadata file ${relative(workspaceRoot, metaPath)}.`)
    }
  }

  const specMtimeMs = statSync(outputSpecAbsolute).mtimeMs
  if (scenarioMtimeMs > specMtimeMs) {
    console.warn('[scenario-runner] WARNING: XML appears newer than generated temp spec (fallback mtime check).')
    console.warn(`[scenario-runner] XML mtime: ${formatIso(scenarioMtimeMs)}`)
    console.warn(`[scenario-runner] Spec mtime: ${formatIso(specMtimeMs)}`)
    console.warn('[scenario-runner] Run with --force to regenerate before execution.')
  }
}

function ensureGeneratedSpec({ scenarioPath, outDir, force, fragmentSource = 'local', software = null }) {
  const scenarioAbsolute = resolve(workspaceRoot, scenarioPath)
  const outputDirAbsolute = resolve(workspaceRoot, outDir)
  const generatorInvocation = buildScenarioXmlGeneratorInvocation({
    scenarioPath: scenarioAbsolute,
    outDir: outputDirAbsolute,
    fragmentSource,
    software,
  })
  const outputSpecAbsolute = generatorInvocation.paths.specPath

  if (!existsSync(scenarioAbsolute)) {
    throw new Error(`Scenario file not found: ${relative(workspaceRoot, scenarioAbsolute)}`)
  }

  const shouldGenerate = force || !existsSync(outputSpecAbsolute)
  if (shouldGenerate) {
    console.log(`Generating temp spec from ${relative(workspaceRoot, scenarioAbsolute)} ...`)
    runCommand(
      generatorInvocation.command,
      generatorInvocation.args,
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

function readVideoConfigFromScenario(_scenarioAbsolutePath, centralConfig) {
  const resolution = normalizeResolution(centralConfig?.video?.resolution)
  if (resolution) {
    return { resolution, source: 'central-config' }
  }
  return { resolution: null, source: 'none' }
}

function runPlaywright(specAbsolutePath, playwrightArgs, mode, scenarioPath, centralConfig, verbose = false, runContext = null) {
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
  const scenarioTestTimeoutMs = resolveScenarioTestTimeoutMs(specAbsolutePath)
  const scenarioRunId = runContext?.scenarioRunId || buildScenarioRunId()

  if (mode === 'video' && videoConfig.resolution) {
    const sourceLabel = videoConfig.source === 'scenario' ? 'XML' : 'central config'
    console.log(`Video resolution from ${sourceLabel}: ${videoConfig.resolution.width}x${videoConfig.resolution.height}`)
  }

  console.log(`Running Playwright test: ${specRelative}`)

  const result = spawnSync('npx', ['playwright', 'test', '--config', configFile, specRelative, ...playwrightArgs], {
    cwd: workspaceRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      SCENARIO_VIDEO_MODE: mode === 'video' ? '1' : '0',
      SCENARIO_VIDEO_SIZE: videoSizeEnv,
      SCENARIO_TEST_TIMEOUT_MS: String(scenarioTestTimeoutMs),
      SCENARIO_RUN_ID: scenarioRunId,
      SCENARIO_ARTIFACTS_DIR: runContext?.artifactsDir || '',
      SCENARIO_REPORT_DIR: runContext?.reportDir || '',
    },
  })

  return {
    exitCode: result.status ?? 1,
    scenarioRunId,
  }
}

async function main() {
  const rawOptions = parseArgs(process.argv.slice(2))
  const central = loadCentralConfig(workspaceRoot, { software: rawOptions.software })
  const testScriptConfig = getTestScriptConfig(central.config)
  const options = applyConfigDefaults(rawOptions, testScriptConfig)
  if (options.help) {
    printUsage()
    return
  }

  const specPath = ensureGeneratedSpec({
    scenarioPath: options.scenarioPath,
    outDir: options.outDir,
    force: options.force || options.verbose,
    fragmentSource: options.fragmentSource,
    software: options.software,
  })

  const scenarioId = parseRequiredScenarioId(options.scenarioId)
  const scenarioRunId = buildScenarioRunId()
  const scenarioRoot = buildScenarioOutputRoot(workspaceRoot, scenarioId)
  const runRoot = join(scenarioRoot, 'runs', scenarioRunId)
  const artifactsDir = join(runRoot, 'artifacts')
  const reportDir = join(runRoot, 'report')

  await mkdir(artifactsDir, { recursive: true })
  await mkdir(reportDir, { recursive: true })

  const playwrightArgs = options.playwrightArgs

  const runResult = runPlaywright(
    specPath,
    playwrightArgs,
    options.mode,
    options.scenarioPath,
    central.config,
    options.verbose,
    {
      scenarioRunId,
      artifactsDir,
      reportDir,
    }
  )

  const runStatus = runResult.exitCode === 0 ? 'passed' : 'failed'
  const persistedArtifacts = await persistScenarioRunArtifacts({
    scenarioPath: options.scenarioPath,
    specPath,
    runRoot,
    artifactsDir,
    mode: options.mode,
    status: runStatus,
    scenarioRunId,
    playwrightExitCode: runResult.exitCode,
  })

  if (persistedArtifacts) {
    console.log(`[scenario-runner] Run artifacts written to ${relative(workspaceRoot, persistedArtifacts.outputRoot)}`)
  }

  const prunedRuns = await pruneScenarioRuns({ scenarioRoot })
  for (const removedRunRoot of prunedRuns.removedRunRoots) {
    console.log(`[scenario-runner] Removed old run: ${relative(workspaceRoot, removedRunRoot)}`)
  }

  if (runResult.exitCode !== 0) {
    throw new Error('Playwright test execution failed.')
  }

}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
