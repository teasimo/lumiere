#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { renderScenarioSpecTemplate } from './generator/templates/spec-template.mjs'
import { loadCentralConfig } from './shared/central-config.mjs'
import { centralDataFunctions } from './generator/central-data-functions.mjs'

const workspaceRoot = process.cwd()
const fallbackScenarioDir = 'lunettes/tests'
const fallbackOutputDir = 'temp/testfiles'
const INTERACTION_SHORTHAND_KEYS = new Set([
  'open',
  'click',
  'fill',
  'append',
  'select',
  'wait',
  'assert',
  'scroll',
  'search-and-select',
  'extract-pdf-code',
  'set-runtime-variable',
])

function printUsage() {
  console.log([
    'Usage:',
    '  npm run generate:testfile -- [<scenario-yaml>] [--out-dir <path>]',
    '  npm run generate:testfiles:all -- [--scenario-dir <path>] [--out-dir <path>]',
    '  npm run clean:testfiles',
    '',
    'Examples:',
    '  npm run generate:testfile -- lunettes/tests/login.yaml',
    '  npm run generate:testfiles:all -- --scenario-dir lunettes/tests --out-dir temp/testfiles',
  ].join('\n'))
}

function parseArgs(argv) {
  const args = [...argv]
  const options = {
    all: false,
    clean: false,
    scenarioPath: null,
    scenarioDir: null,
    outDir: null,
  }

  while (args.length) {
    const token = args.shift()

    if (token === '--help' || token === '-h') {
      options.help = true
      return options
    }

    if (token === '--all') {
      options.all = true
      continue
    }

    if (token === '--clean') {
      options.clean = true
      continue
    }

    if (token === '--scenario-dir') {
      options.scenarioDir = args.shift() || null
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
      throw new Error('Only one scenario file path is supported in single-file mode.')
    }

    options.scenarioPath = token
  }

  return options
}

function applyConfigDefaults(options, centralConfig) {
  const defaults = centralConfig?.defaults || {}
  const scenarioDir = options.scenarioDir || defaults.scenario_dir || fallbackScenarioDir
  const outDir = options.outDir || defaults.output_dir || fallbackOutputDir

  let scenarioPath = options.scenarioPath
  if (!options.all && !scenarioPath) {
    scenarioPath = defaults.scenario_path || join(scenarioDir, 'login.yaml')
  }

  return {
    ...options,
    scenarioDir,
    outDir,
    scenarioPath,
  }
}

function resolveTemplateString(text, context, dataFunctions = {}) {
  if (typeof text !== 'string') return text

  return text.replace(/{{\s*([^}]+)\s*}}/g, (_, pathExpr) => {
    const expr = String(pathExpr || '').trim()
    if (!expr) return ''

    // Check if it's a function call: functionName()
    const funcMatch = expr.match(/^(\w+)\s*\(\s*\)$/)
    if (funcMatch) {
      const funcName = funcMatch[1]
      if (typeof dataFunctions[funcName] === 'function') {
        try {
          const result = dataFunctions[funcName]()
          return result === undefined || result === null ? '' : String(result)
        } catch (error) {
          console.warn(`Error calling data function ${funcName}: ${error.message}`)
          return ''
        }
      }
      return ''
    }

    // Otherwise treat as property path: runtime.base_url
    const value = expr.split('.').reduce((acc, key) => {
      if (acc && Object.prototype.hasOwnProperty.call(acc, key)) {
        return acc[key]
      }
      return undefined
    }, context)

    return value === undefined || value === null ? `{{${expr}}}` : String(value)
  })
}

function normalizeInteractionShorthandStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    return step
  }

  if (step.interaction && typeof step.interaction === 'object' && !Array.isArray(step.interaction)) {
    return step
  }

  const shorthandKeys = Object.keys(step).filter((key) => INTERACTION_SHORTHAND_KEYS.has(key))
  if (shorthandKeys.length === 0) {
    return step
  }

  if (shorthandKeys.length > 1) {
    throw new Error(`Step "${String(step.id || 'unknown')}" mixes multiple shorthand interactions: ${shorthandKeys.join(', ')}`)
  }

  const shorthandType = shorthandKeys[0]
  const shorthandValue = step[shorthandType]
  const nextStep = { ...step }
  delete nextStep[shorthandType]

  const interaction = { type: shorthandType }

  if (shorthandValue && typeof shorthandValue === 'object' && !Array.isArray(shorthandValue)) {
    interaction.target = shorthandValue
  } else if (shorthandValue != null && shorthandType === 'open') {
    interaction.target = { url: String(shorthandValue) }
  } else if (shorthandValue != null && shorthandType !== 'wait') {
    interaction.target = { 'data-id': String(shorthandValue) }
  }

  if (nextStep.value != null && interaction.value == null) {
    interaction.value = nextStep.value
    delete nextStep.value
  }

  if (nextStep.state != null && interaction.state == null) {
    interaction.state = nextStep.state
    delete nextStep.state
  }

  if (nextStep.resultSelector != null && interaction.resultSelector == null) {
    interaction.resultSelector = nextStep.resultSelector
    delete nextStep.resultSelector
  }

  if (nextStep.resultIndex != null && interaction.resultIndex == null) {
    interaction.resultIndex = nextStep.resultIndex
    delete nextStep.resultIndex
  }

  if (nextStep.output != null && interaction.output == null) {
    interaction.output = nextStep.output
    delete nextStep.output
  }

  if (nextStep.pdfPath != null && interaction.pdfPath == null) {
    interaction.pdfPath = nextStep.pdfPath
    delete nextStep.pdfPath
  }

  if (nextStep.regex != null && interaction.regex == null) {
    interaction.regex = nextStep.regex
    delete nextStep.regex
  }

  nextStep.interaction = interaction
  return nextStep
}

function normalizeFlowInteractionShorthand(flowEntries) {
  return (flowEntries || []).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry
    }

    const normalizedEntry = normalizeInteractionShorthandStep(entry)
    const nestedFlow = Array.isArray(normalizedEntry.flow)
      ? normalizeFlowInteractionShorthand(normalizedEntry.flow)
      : undefined

    if (nestedFlow) {
      return {
        ...normalizedEntry,
        flow: nestedFlow,
      }
    }

    return normalizedEntry
  })
}

function collectFlowStepIds(flowEntries, out = []) {
  for (const step of flowEntries || []) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      continue
    }

    const stepId = String(step.id || '').trim()
    if (stepId) {
      out.push(stepId)
    }

    if (Array.isArray(step.flow) && step.flow.length > 0) {
      collectFlowStepIds(step.flow, out)
    }
  }

  return out
}

function assertUniqueFlowStepIds(flowEntries, scenarioPath) {
  const ids = collectFlowStepIds(flowEntries)
  const counts = new Map()

  for (const id of ids) {
    counts.set(id, (counts.get(id) || 0) + 1)
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => left[0].localeCompare(right[0]))

  if (duplicates.length === 0) {
    return
  }

  const duplicateText = duplicates.map(([id, count]) => `${id} (${count}x)`).join(', ')
  throw new Error(`Duplicate step ids are not allowed in scenario "${scenarioPath}": ${duplicateText}`)
}

function setPathValue(target, pathExpr, value) {
  const path = String(pathExpr || '').trim()
  if (!path) {
    return
  }

  const keys = path.split('.').filter(Boolean)
  if (!keys.length) {
    return
  }

  let cursor = target
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }

  cursor[keys[keys.length - 1]] = value
}

function getPathValue(source, pathExpr) {
  const path = String(pathExpr || '').trim()
  if (!path) {
    return undefined
  }

  return path.split('.').reduce((acc, key) => {
    if (acc && Object.prototype.hasOwnProperty.call(acc, key)) {
      return acc[key]
    }
    return undefined
  }, source)
}

function buildIncludeOverrideContext(providedWith) {
  const overrides = {}

  for (const [key, value] of Object.entries(providedWith || {})) {
    if (key.includes('.')) {
      setPathValue(overrides, key, value)
      continue
    }

    overrides[key] = value
  }

  return overrides
}

function hasContextParameter(context, parameterName) {
  if (Object.prototype.hasOwnProperty.call(context, parameterName)) {
    return true
  }

  return getPathValue(context, parameterName) !== undefined
}

function resolveTemplatesDeep(value, context, dataFunctions = {}) {
  if (typeof value === 'string') {
    return resolveTemplateString(value, context, dataFunctions)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplatesDeep(entry, context, dataFunctions))
  }

  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, subValue] of Object.entries(value)) {
      out[key] = resolveTemplatesDeep(subValue, context, dataFunctions)
    }
    return out
  }

  return value
}

function resolveDataSection(data, dataFunctions = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {}
  }

  const resolved = {}
  const context = { ...data }

  // Resolve keys in declaration order so later keys can reuse already resolved values.
  for (const [key, value] of Object.entries(data)) {
    const resolvedValue = resolveTemplatesDeep(value, context, dataFunctions)
    resolved[key] = resolvedValue
    context[key] = resolvedValue
  }

  return resolved
}

async function fileExists(filePath) {
  try {
    const fileStat = await stat(filePath)
    return fileStat.isFile()
  } catch {
    return false
  }
}

async function resolveExistingPath(candidatePaths) {
  for (const candidatePath of candidatePaths) {
    if (await fileExists(candidatePath)) {
      return candidatePath
    }
  }

  return null
}

async function resolveFragmentPath(includePath, { baseDir, includeRootDir }) {
  const includePathString = String(includePath || '').trim()
  const rawAbsolutePath = includePathString.startsWith('/')
    ? resolve(includeRootDir, includePathString.slice(1))
    : resolve(baseDir, includePathString)
  const normalizedExt = extname(rawAbsolutePath).toLowerCase()
  const withoutExt = rawAbsolutePath.slice(0, rawAbsolutePath.length - normalizedExt.length)

  const candidatePaths = [rawAbsolutePath]

  if (normalizedExt === '.yml') {
    candidatePaths.push(`${withoutExt}.yaml`)
  } else if (normalizedExt === '.yaml') {
    candidatePaths.push(`${withoutExt}.yml`)
  } else {
    candidatePaths.push(`${rawAbsolutePath}.yaml`)
    candidatePaths.push(`${rawAbsolutePath}.yml`)
  }

  const resolved = await resolveExistingPath(candidatePaths)
  if (!resolved) {
    throw new Error(`Could not resolve included fragment path "${includePath}" from ${baseDir} (include root: ${includeRootDir})`)
  }

  return resolved
}

async function loadYamlDocument(filePath) {
  const source = await readFile(filePath, 'utf8')
  return parseYaml(source)
}

function prefixFlowEntryId(entry, prefix) {
  if (!prefix || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return entry
  }

  const nextEntry = { ...entry }
  if (typeof nextEntry.id === 'string' && nextEntry.id.trim()) {
    nextEntry.id = `${prefix}-${nextEntry.id.trim()}`
  }

  return nextEntry
}

function createIncludeOutputSteps(outputs, { idPrefix = '', includeStepId = '' } = {}) {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    return []
  }

  const baseId = String(includeStepId || 'include').trim() || 'include'

  return Object.entries(outputs).map(([outputPath, outputValue], index) => {
    const outputToken = String(outputPath)
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `output-${index + 1}`

    return prefixFlowEntryId({
      id: `${baseId}-output-${outputToken}`,
      interaction: {
        type: 'set-runtime-variable',
        output: outputPath,
        value: outputValue,
      },
    }, idPrefix)
  })
}

async function loadFragmentLibrary(scenarioPath) {
  let currentDir = dirname(resolve(scenarioPath))

  while (true) {
    const candidatePaths = [
      join(currentDir, 'fragements', 'fragment-library.json'),
      join(currentDir, 'fragments', 'fragment-library.json'),
    ]

    for (const libraryPath of candidatePaths) {
      try {
        const source = await readFile(libraryPath, 'utf8')
        return { library: JSON.parse(source), libraryPath }
      } catch {
        // keep searching parent directories
      }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  return null
}

function mergePresentationMetadata(basePresentation, inheritedPresentation) {
  if (!inheritedPresentation || typeof inheritedPresentation !== 'object' || Array.isArray(inheritedPresentation)) {
    return basePresentation
  }

  if (!basePresentation || typeof basePresentation !== 'object' || Array.isArray(basePresentation)) {
    return inheritedPresentation
  }

  return {
    ...basePresentation,
    ...inheritedPresentation,
    didactics: {
      ...(basePresentation.didactics || {}),
      ...(inheritedPresentation.didactics || {}),
    },
    video: {
      ...(basePresentation.video || {}),
      ...(inheritedPresentation.video || {}),
    },
  }
}

function applyEntryPresentationToExpandedFlow(expandedFlow, entry, context, dataFunctions) {
  if (!Array.isArray(expandedFlow) || expandedFlow.length === 0) {
    return expandedFlow
  }

  if (!entry || typeof entry !== 'object' || !entry.presentation) {
    return expandedFlow
  }

  const resolvedPresentation = resolveTemplatesDeep(entry.presentation, context, dataFunctions)
  if (!resolvedPresentation || typeof resolvedPresentation !== 'object' || Array.isArray(resolvedPresentation)) {
    return expandedFlow
  }

  const [firstStep, ...restSteps] = expandedFlow
  const nextFirstStep = {
    ...firstStep,
    presentation: mergePresentationMetadata(firstStep.presentation, resolvedPresentation),
  }

  return [nextFirstStep, ...restSteps]
}

async function expandFlowIncludes(flowEntries, { baseDir, includeRootDir, fragmentLibrary = null, context, dataFunctions, includeStack = [], idPrefix = '' }) {
  const expanded = []

  for (const entry of flowEntries || []) {
    if (entry && typeof entry === 'object' && Array.isArray(entry.flow)) {
      const blockPrefix = String(entry.id || '').trim() || String(entry.fragmentId || '').trim() || ''
      const nextPrefix = idPrefix && blockPrefix ? `${idPrefix}-${blockPrefix}` : (blockPrefix || idPrefix)
      const resolvedNestedFlow = await expandFlowIncludes(entry.flow, {
        baseDir,
        includeRootDir,
        fragmentLibrary,
        context,
        dataFunctions,
        includeStack,
        idPrefix: nextPrefix,
      })

      const resolvedEntry = resolveTemplatesDeep({ ...entry, flow: undefined }, context, dataFunctions)
      const normalizedEntry = normalizeInteractionShorthandStep(resolvedEntry)
      const prefixedEntry = prefixFlowEntryId(normalizedEntry, idPrefix)
      expanded.push({
        ...prefixedEntry,
        flow: resolvedNestedFlow,
      })
      continue
    }

    if (entry && typeof entry === 'object' && (entry.fragement || entry.fragment)) {
      const fragmentId = String(entry.fragement ?? entry.fragment ?? '').trim()
      if (!fragmentLibrary) {
        throw new Error(`Cannot resolve fragment "${fragmentId}": no fragment library found. Run "npm run build:fragment-library" first.`)
      }
      const relPath = fragmentLibrary.library[fragmentId]
      if (!relPath) {
        throw new Error(`Fragment id "${fragmentId}" not found in library (${fragmentLibrary.libraryPath}). Run "npm run build:fragment-library" to update it.`)
      }
      const fragmentPath = resolve(workspaceRoot, relPath)
      const fragmentPrefix = String(entry.id || '').trim() || String(entry.fragmentId || '').trim() || ''
      const nextPrefix = idPrefix && fragmentPrefix ? `${idPrefix}-${fragmentPrefix}` : (fragmentPrefix || idPrefix)

      if (includeStack.includes(fragmentPath)) {
        throw new Error(`Circular include detected: ${[...includeStack, fragmentPath].join(' -> ')}`)
      }

      const fragmentDocument = await loadYamlDocument(fragmentPath)
      const fragment = fragmentDocument?.fragment
      if (!fragment || typeof fragment !== 'object') {
        throw new Error(`Fragment file "${fragmentPath}" must have a top-level "fragment" object.`)
      }

      const fragmentParameters = Array.isArray(fragment.parameters) ? fragment.parameters : []
      const providedWith = resolveTemplatesDeep(entry.with || {}, context, dataFunctions)
      const includeOverrides = buildIncludeOverrideContext(providedWith)
      const fragmentContext = {
        ...context,
        ...includeOverrides,
      }

      for (const parameterName of fragmentParameters) {
        if (!hasContextParameter(fragmentContext, parameterName)) {
          throw new Error(`Missing fragment parameter "${parameterName}" for fragment "${fragmentId}" in ${fragmentPath}`)
        }
      }

      const fragmentFlow = Array.isArray(fragment.flow) ? fragment.flow : []
      const fragementsRoot = dirname(fragmentLibrary.libraryPath)
      let resolvedFragmentFlow = await expandFlowIncludes(fragmentFlow, {
        baseDir: dirname(fragmentPath),
        includeRootDir: fragementsRoot,
        fragmentLibrary,
        context: fragmentContext,
        dataFunctions,
        includeStack: [...includeStack, fragmentPath],
        idPrefix: nextPrefix,
      })
      resolvedFragmentFlow = applyEntryPresentationToExpandedFlow(resolvedFragmentFlow, entry, context, dataFunctions)

      expanded.push(...resolvedFragmentFlow)
      expanded.push(...createIncludeOutputSteps(resolveTemplatesDeep(entry.outputs || {}, context, dataFunctions), {
        idPrefix,
        includeStepId: fragmentPrefix,
      }))
      continue
    }

    if (entry && typeof entry === 'object' && entry.include) {
      const includePathTemplate = String(entry.include ?? '')
      const includePath = resolveTemplateString(includePathTemplate, context, dataFunctions)
      const fragmentPath = await resolveFragmentPath(includePath, { baseDir, includeRootDir })
      const fragmentPrefix = String(entry.id || '').trim() || String(entry.fragmentId || '').trim() || ''
      const nextPrefix = idPrefix && fragmentPrefix ? `${idPrefix}-${fragmentPrefix}` : (fragmentPrefix || idPrefix)

      if (includeStack.includes(fragmentPath)) {
        throw new Error(`Circular include detected: ${[...includeStack, fragmentPath].join(' -> ')}`)
      }

      const fragmentDocument = await loadYamlDocument(fragmentPath)
      const fragment = fragmentDocument?.fragment
      if (!fragment || typeof fragment !== 'object') {
        throw new Error(`Included fragment "${fragmentPath}" must have a top-level "fragment" object.`)
      }

      const fragmentParameters = Array.isArray(fragment.parameters) ? fragment.parameters : []
      const providedWith = resolveTemplatesDeep(entry.with || {}, context, dataFunctions)
      const includeOverrides = buildIncludeOverrideContext(providedWith)
      const fragmentContext = {
        ...context,
        ...includeOverrides,
      }

      for (const parameterName of fragmentParameters) {
        if (!hasContextParameter(fragmentContext, parameterName)) {
          throw new Error(`Missing fragment parameter "${parameterName}" for include "${includePath}" in ${fragmentPath}`)
        }
      }

      const fragmentFlow = Array.isArray(fragment.flow) ? fragment.flow : []
      let resolvedFragmentFlow = await expandFlowIncludes(fragmentFlow, {
        baseDir: dirname(fragmentPath),
        includeRootDir,
        fragmentLibrary,
        context: fragmentContext,
        dataFunctions,
        includeStack: [...includeStack, fragmentPath],
        idPrefix: nextPrefix,
      })
      resolvedFragmentFlow = applyEntryPresentationToExpandedFlow(resolvedFragmentFlow, entry, context, dataFunctions)

      expanded.push(...resolvedFragmentFlow)
      expanded.push(...createIncludeOutputSteps(resolveTemplatesDeep(entry.outputs || {}, context, dataFunctions), {
        idPrefix,
        includeStepId: fragmentPrefix,
      }))
      continue
    }

    const resolvedEntry = resolveTemplatesDeep(entry, context, dataFunctions)
    const normalizedEntry = normalizeInteractionShorthandStep(resolvedEntry)
    expanded.push(prefixFlowEntryId(normalizedEntry, idPrefix))
  }

  return expanded
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function deriveEnvFillStrategiesAbsolutePath(scenarioPath) {
  const scenarioRelative = toPosixPath(relative(workspaceRoot, resolve(scenarioPath)))
  const marker = '/tests/'
  const markerIndex = scenarioRelative.indexOf(marker)

  if (markerIndex <= 0) {
    return null
  }

  const appRoot = scenarioRelative.slice(0, markerIndex)
  return resolve(workspaceRoot, appRoot, 'env', 'fill-strategies.mjs')
}

function resolveEnvFillStrategiesImportPath({ scenarioPath, generatedSpecPath }) {
  const envFillStrategiesAbsolutePath = deriveEnvFillStrategiesAbsolutePath(scenarioPath)
  if (!envFillStrategiesAbsolutePath) {
    return null
  }

  const generatedSpecDir = dirname(generatedSpecPath)
  const relativeImportPath = toPosixPath(relative(generatedSpecDir, envFillStrategiesAbsolutePath))
  if (!relativeImportPath) {
    return null
  }

  if (relativeImportPath.startsWith('.')) {
    return relativeImportPath
  }

  return `./${relativeImportPath}`
}

function deriveEnvDataFunctionsAbsolutePath(scenarioPath) {
  const scenarioRelative = toPosixPath(relative(workspaceRoot, resolve(scenarioPath)))
  const marker = '/tests/'
  const markerIndex = scenarioRelative.indexOf(marker)

  if (markerIndex <= 0) {
    return null
  }

  const appRoot = scenarioRelative.slice(0, markerIndex)
  return resolve(workspaceRoot, appRoot, 'env', 'data-functions.mjs')
}

async function loadDataFunctions(scenarioPath) {
  const allFunctions = { ...centralDataFunctions }

  const envDataFunctionsAbsolutePath = deriveEnvDataFunctionsAbsolutePath(scenarioPath)
  if (envDataFunctionsAbsolutePath) {
    try {
      const module = await import(envDataFunctionsAbsolutePath)
      const exported = module?.dataFunctions ?? module?.default ?? {}
      if (typeof exported === 'object') {
        Object.assign(allFunctions, exported)
      }
    } catch (error) {
      // silently ignore if app-specific data functions don't exist
    }
  }

  return allFunctions
}

async function scenarioToSpecSource(scenario, scenarioPath, centralConfig, generatedSpecPath) {
  const root = scenario?.interaction
  if (!root || typeof root !== 'object') {
    throw new Error('Scenario root "interaction" is missing or invalid.')
  }

  const flow = Array.isArray(root.flow) ? root.flow : []
  if (!flow.length) {
    throw new Error('Scenario contains no flow steps.')
  }

  const rootWithDefaults = {
    ...root,
    video: {
      ...(root.video || {}),
    },
  }
  if (rootWithDefaults.video.wait_between_steps == null) {
    rootWithDefaults.video.wait_between_steps = centralConfig?.video?.wait_between_steps
  }
  if (rootWithDefaults.video.scroll_delay_ms == null) {
    rootWithDefaults.video.scroll_delay_ms = centralConfig?.video?.scroll_delay_ms
  }
  if (rootWithDefaults.video.autoscroll_smooth == null) {
    rootWithDefaults.video.autoscroll_smooth = centralConfig?.video?.autoscroll_smooth
  }

  // Load data functions (central + app-specific)
  const dataFunctions = await loadDataFunctions(scenarioPath)

  // First, resolve data section with functions (which may reference other data values)
  const resolvedData = resolveDataSection(rootWithDefaults.data || {}, dataFunctions)

  // Load fragment library (built by scripts/build-fragment-library.mjs)
  const fragmentLibrary = await loadFragmentLibrary(scenarioPath)

  // Expand flow includes before the general template resolution so fragments become part of one complete scenario.
  const expandedFlow = await expandFlowIncludes(rootWithDefaults.flow || [], {
    baseDir: dirname(resolve(scenarioPath)),
    includeRootDir: dirname(resolve(scenarioPath)),
    fragmentLibrary,
    context: {
      ...resolvedData,
    },
    dataFunctions,
    idPrefix: '',
  })

  const scenarioWithExpandedFlow = {
    ...rootWithDefaults,
    data: resolvedData,
    flow: expandedFlow,
  }

  // Then resolve the entire root using the resolved data as context.
  const resolvedRoot = resolveTemplatesDeep(
    scenarioWithExpandedFlow,
    {
      ...resolvedData,
    },
    dataFunctions,
  )


  const envFillStrategiesImportPath = resolveEnvFillStrategiesImportPath({
    scenarioPath,
    generatedSpecPath,
  })

  const normalizedResolvedRoot = {
    ...resolvedRoot,
    flow: normalizeFlowInteractionShorthand(Array.isArray(resolvedRoot.flow) ? resolvedRoot.flow : []),
  }

  assertUniqueFlowStepIds(normalizedResolvedRoot.flow, scenarioPath)

  const specSource = renderScenarioSpecTemplate({
    resolvedRoot: normalizedResolvedRoot,
    scenarioPathRelative: relative(workspaceRoot, resolve(scenarioPath)),
    envFillStrategiesImportPath,
  })

  return {
    specSource,
    resolvedRoot: normalizedResolvedRoot,
  }
}

function getResolvedYamlOutputPath(specOutputPath) {
  if (specOutputPath.endsWith('.spec.js')) {
    return specOutputPath.slice(0, -'.spec.js'.length) + '.resolved.yaml'
  }
  return `${specOutputPath}.resolved.yaml`
}

async function collectScenarioFiles(options) {
  if (!options.all) {
    return [resolve(workspaceRoot, options.scenarioPath)]
  }

  const dir = resolve(workspaceRoot, options.scenarioDir)
  const files = []

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }

      if (entry.isFile() && ['.yaml', '.yml'].includes(extname(entry.name).toLowerCase())) {
        files.push(absolute)
      }
    }
  }

  await walk(dir)
  return files.sort()
}

async function cleanOutputDirectory(outDirPath) {
  await mkdir(outDirPath, { recursive: true })
  const entries = await readdir(outDirPath, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith('.spec.js') || entry.name.endsWith('.spec.js.meta.json'))) {
      await rm(join(outDirPath, entry.name), { force: true })
    }
  }
}

async function generateOne(scenarioFilePath, outDirPath, centralConfig) {
  const yamlSource = await readFile(scenarioFilePath, 'utf8')
  const yamlStats = await stat(scenarioFilePath)
  const parsed = parseYaml(yamlSource)

  const outputBaseName = `${basename(scenarioFilePath, extname(scenarioFilePath))}.spec.js`
  const outputPath = join(outDirPath, outputBaseName)
  const { specSource, resolvedRoot } = await scenarioToSpecSource(parsed, scenarioFilePath, centralConfig, outputPath)
  const metaPath = `${outputPath}.meta.json`
  const resolvedYamlPath = getResolvedYamlOutputPath(outputPath)

  await writeFile(outputPath, specSource, 'utf8')
  await writeFile(
    resolvedYamlPath,
    stringifyYaml({ interaction: resolvedRoot }),
    'utf8'
  )
  await writeFile(
    metaPath,
    JSON.stringify({
      generatedAtIso: new Date().toISOString(),
      generatedAtMs: Date.now(),
      scenarioPathRelative: relative(workspaceRoot, resolve(scenarioFilePath)),
      resolvedYamlPathRelative: relative(workspaceRoot, resolvedYamlPath),
      sourceYamlMtimeIso: yamlStats.mtime.toISOString(),
      sourceYamlMtimeMs: yamlStats.mtimeMs,
    }, null, 2),
    'utf8'
  )

  return outputPath
}

async function main() {
  const central = loadCentralConfig(workspaceRoot)
  const rawOptions = parseArgs(process.argv.slice(2))
  const options = applyConfigDefaults(rawOptions, central.config)

  if (options.help) {
    printUsage()
    return
  }

  const outDirPath = resolve(workspaceRoot, options.outDir)
  if (options.clean) {
    await cleanOutputDirectory(outDirPath)
    console.log(`Cleaned generated spec files in ${relative(workspaceRoot, outDirPath)}`)
    return
  }

  const scenarioFiles = await collectScenarioFiles(options)
  if (!scenarioFiles.length) {
    throw new Error('No scenario yaml files found.')
  }

  await mkdir(outDirPath, { recursive: true })

  const written = []
  for (const scenarioFilePath of scenarioFiles) {
    const outputPath = await generateOne(scenarioFilePath, outDirPath, central.config)
    written.push(outputPath)
  }

  console.log(`Generated ${written.length} test file(s):`)
  for (const outputPath of written) {
    console.log(`- ${relative(workspaceRoot, outputPath)}`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
