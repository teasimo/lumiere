#!/usr/bin/env node

import { cp, mkdir, writeFile } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { spawnSync } from 'child_process'
import { XMLParser } from 'fast-xml-parser'
import { getTestScriptConfig, loadCentralConfig } from '../shared/central-config.mjs'
import { buildScenarioOutputRoot, sanitizeScenarioOutputToken } from '../shared/scenario-output.mjs'

const workspaceRoot = process.cwd()
const fallbackScenarioPath = 'neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml'
const fallbackOutputDir = 'temp/testfiles'
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
})

function printUsage() {
  console.log([
    'Usage:',
    '  npm run check:testfile -- [<scenario-xml>] [--force] [--out-dir <path>] [-- <playwright-args>]',
    '  npm run run:testfile-script -- [<scenario-xml>] [--force] [--out-dir <path>] [-- <playwright-args>]',
    '',
    'Examples:',
    '  npm run check:testfile -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml',
    '  npm run check:testfile:force -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml',
    '  npm run run:testfile-script -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml',
    '  npm run run:testfile-script -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml -- --project=chromium',
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

function readScenarioIdentity(scenarioAbsolutePath) {
  const fallbackId = sanitizeFileToken(basename(scenarioAbsolutePath, extname(scenarioAbsolutePath)), 'scenario')

  try {
    const raw = readFileSync(scenarioAbsolutePath, 'utf8')
    const parsed = xmlParser.parse(raw) || {}
    const root = parsed?.SzenarioScript || {}
    const scenarioId = sanitizeFileToken(root['@_id'] || fallbackId, fallbackId)
    const scenarioVersion = root['@_szenario-version'] ?? 'unknown'
    const lunettesId = String(root['@_lunettes-id'] || '').trim()
    return { scenarioId, scenarioVersion, lunettesId }
  } catch {
    return { scenarioId: fallbackId, scenarioVersion: 'unknown', lunettesId: '' }
  }
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function buildBasicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return `Basic ${token}`
}

async function notifyLunettesTestscriptSuccess({
  scenarioPath,
  centralConfig,
}) {
  const lunettesApiConfig = centralConfig?.['test-script']?.lunettes_api || {}
  const baseUrl = normalizeBaseUrl(lunettesApiConfig.base_url)
  if (!baseUrl) {
    return
  }

  const scenarioAbsolutePath = resolve(workspaceRoot, scenarioPath)
  const { scenarioId, lunettesId } = readScenarioIdentity(scenarioAbsolutePath)
  if (!lunettesId) {
    throw new Error(
      `Lunettes API callback configured, but XML ${relative(workspaceRoot, scenarioAbsolutePath)} is missing "lunettes-id".`
    )
  }

  const username = String(process.env.LUNETTES_API_USERNAME || '').trim()
  const password = String(process.env.LUNETTES_API_PASSWORD || '')
  if (!username || !password) {
    throw new Error('Lunettes API callback configured, but LUNETTES_API_USERNAME or LUNETTES_API_PASSWORD is missing.')
  }

  const endpoint = `${baseUrl}/api/anfo/szenario/${encodeURIComponent(lunettesId)}/testscript-erfolgreich`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: buildBasicAuthHeader(username, password),
    },
  })

  let responsePayload = null
  let responseText = ''
  try {
    responseText = await response.text()
    responsePayload = responseText ? JSON.parse(responseText) : null
  } catch {
    responsePayload = responseText || null
  }

  if (!response.ok) {
    const details = responsePayload ? ` Response: ${JSON.stringify(responsePayload)}` : ''
    throw new Error(
      `Lunettes API callback failed for scenario ${scenarioId} (lunettes-id=${lunettesId}) with HTTP ${response.status}.${details}`
    )
  }

  console.log(
    `[scenario-runner] Lunettes callback sent: ${relative(workspaceRoot, scenarioAbsolutePath)} -> ${endpoint}`
  )
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
      target?.testid || target?.id || target?.['data-id'] || target?.text || Object.keys(target || {}).some((key) => (
        !['testid', 'id', 'data-id', 'text', 'role', 'url', 'state', 'click_child_selector', 'number'].includes(key)
        && target[key] != null
      ))
    )
    if (['click', 'fill', 'append', 'select', 'upload', 'search-and-select'].includes(interactionType) && hasUsableScrollTarget) {
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
      ['scripts/test-script-generator/generate-tests-from-scenario-xml.mjs', relative(workspaceRoot, scenarioAbsolute), '--out-dir', relative(workspaceRoot, outputDirAbsolute)],
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
    const parsed = xmlParser.parse(raw) || {}
    const root = parsed?.SzenarioScript || {}

    const settingsEntries = root?.Einstellungen
      ? (Array.isArray(root.Einstellungen) ? root.Einstellungen : [root.Einstellungen])
      : []

    const findGroupByName = (groupCandidate, groupName) => {
      if (!groupCandidate) return null
      const groups = groupCandidate.Gruppe
      const list = Array.isArray(groups) ? groups : (groups ? [groups] : [])
      return list.find((entry) => String(entry?.['@_name'] || '').trim() === groupName) || null
    }

    let videoGroup = null
    for (const settings of settingsEntries) {
      videoGroup = findGroupByName(settings, 'video')
      if (videoGroup) break
    }

    const resolutionGroup = findGroupByName(videoGroup, 'resolution')
    const resolutionEntries = resolutionGroup?.Einstellung
    const resolutionList = Array.isArray(resolutionEntries) ? resolutionEntries : (resolutionEntries ? [resolutionEntries] : [])
    const widthSetting = resolutionList.find((entry) => String(entry?.['@_name'] || '').trim() === 'width')
    const heightSetting = resolutionList.find((entry) => String(entry?.['@_name'] || '').trim() === 'height')
    const scenarioResolution = normalizeResolution({
      width: widthSetting?.['@_value'],
      height: heightSetting?.['@_value'],
    })

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
  const central = loadCentralConfig(workspaceRoot)
  const testScriptConfig = getTestScriptConfig(central.config)
  const rawOptions = parseArgs(process.argv.slice(2))
  const options = applyConfigDefaults(rawOptions, testScriptConfig)
  if (options.help) {
    printUsage()
    return
  }

  const specPath = ensureGeneratedSpec({
    scenarioPath: options.scenarioPath,
    outDir: options.outDir,
    force: options.force || options.verbose,
  })

  const scenarioAbsolutePath = resolve(workspaceRoot, options.scenarioPath)
  const { scenarioId } = readScenarioIdentity(scenarioAbsolutePath)
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

  if (runResult.exitCode !== 0) {
    throw new Error('Playwright test execution failed.')
  }

  await notifyLunettesTestscriptSuccess({
    scenarioPath: options.scenarioPath,
    centralConfig: central.config,
  })
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
