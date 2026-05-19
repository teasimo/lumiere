#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { parse as parseYaml } from 'yaml'
import { renderScenarioSpecTemplate } from './generator/templates/spec-template.mjs'
import { loadCentralConfig } from './shared/central-config.mjs'
import { centralDataFunctions } from './generator/central-data-functions.mjs'

const workspaceRoot = process.cwd()
const fallbackScenarioDir = 'lunettes/tests'
const fallbackOutputDir = 'temp/testfiles'

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

    return value === undefined || value === null ? '' : String(value)
  })
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

async function resolveFragmentPath(includePath, baseDir) {
  const rawAbsolutePath = resolve(baseDir, includePath)
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
    throw new Error(`Could not resolve included fragment path "${includePath}" from ${baseDir}`)
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

async function expandFlowIncludes(flowEntries, { baseDir, context, dataFunctions, includeStack = [], idPrefix = '' }) {
  const expanded = []

  for (const entry of flowEntries || []) {
    if (entry && typeof entry === 'object' && entry.include) {
      const includePathTemplate = String(entry.include ?? '')
      const includePath = resolveTemplateString(includePathTemplate, context, dataFunctions)
      const fragmentPath = await resolveFragmentPath(includePath, baseDir)
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
      const fragmentContext = {
        ...context,
        ...providedWith,
      }

      for (const parameterName of fragmentParameters) {
        if (!Object.prototype.hasOwnProperty.call(fragmentContext, parameterName)) {
          throw new Error(`Missing fragment parameter "${parameterName}" for include "${includePath}" in ${fragmentPath}`)
        }
      }

      const fragmentFlow = Array.isArray(fragment.flow) ? fragment.flow : []
      const resolvedFragmentFlow = await expandFlowIncludes(fragmentFlow, {
        baseDir: dirname(fragmentPath),
        context: fragmentContext,
        dataFunctions,
        includeStack: [...includeStack, fragmentPath],
        idPrefix: nextPrefix,
      })

      expanded.push(...resolvedFragmentFlow)
      continue
    }

    const resolvedEntry = resolveTemplatesDeep(entry, context, dataFunctions)
    expanded.push(prefixFlowEntryId(resolvedEntry, idPrefix))
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

  // Load data functions (central + app-specific)
  const dataFunctions = await loadDataFunctions(scenarioPath)

  // First, resolve data section with functions (which may reference other data values)
  const resolvedData = resolveTemplatesDeep(
    rootWithDefaults.data || {},
    rootWithDefaults.data || {},
    dataFunctions,
  )

  // Expand flow includes before the general template resolution so fragments become part of one complete scenario.
  const expandedFlow = await expandFlowIncludes(rootWithDefaults.flow || [], {
    baseDir: dirname(resolve(scenarioPath)),
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

  return renderScenarioSpecTemplate({
    resolvedRoot,
    scenarioPathRelative: relative(workspaceRoot, resolve(scenarioPath)),
    envFillStrategiesImportPath,
  })
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
  const specSource = await scenarioToSpecSource(parsed, scenarioFilePath, centralConfig, outputPath)
  const metaPath = `${outputPath}.meta.json`

  await writeFile(outputPath, specSource, 'utf8')
  await writeFile(
    metaPath,
    JSON.stringify({
      generatedAtIso: new Date().toISOString(),
      generatedAtMs: Date.now(),
      scenarioPathRelative: relative(workspaceRoot, resolve(scenarioFilePath)),
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
