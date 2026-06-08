#!/usr/bin/env node

import { execFile } from 'child_process'
import { promisify } from 'util'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { renderScenarioSpecTemplate } from './templates/spec-template.mjs'
import {
  getScenarioEnvFillStrategiesFilename,
  getScenarioSpecSupportFilenames,
} from './templates/spec-template-base.mjs'
import { getTestScriptConfig, loadCentralConfig } from '../shared/central-config.mjs'
import { centralDataFunctions } from './central-data-functions.mjs'

const execFileAsync = promisify(execFile)

const workspaceRoot = process.cwd()
const fallbackScenarioDir = 'neo/interactions'
const fallbackOutputDir = 'temp/testfiles'
const fallbackXsdPath = 'schemas/szenarioscript.xsd'

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: false,
})

const builder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  suppressEmptyNode: false,
})

const INTERACTION_TAGS = new Set([
  'Click',
  'Eingabe',
  'Auswahl',
  'Anzeige',
  'Warten',
  'Oeffnen',
  'SucheAuswahl',
])

const RESOLVED_TITLE_SOURCE_ATTRS = [
  'data-id',
  'id',
  'text',
  'aria-label',
  'label',
  'url',
  'suchwert',
  'status',
]

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/test-script-generator/generate-tests-from-scenario-xml.mjs [<scenario-xml>] [--xsd <path>] [--out-dir <path>]',
    '  node scripts/test-script-generator/generate-tests-from-scenario-xml.mjs --all [--scenario-dir <path>] [--xsd <path>] [--out-dir <path>]',
    '  node scripts/test-script-generator/generate-tests-from-scenario-xml.mjs --clean [--out-dir <path>]',
    '',
    'Examples:',
    '  node scripts/test-script-generator/generate-tests-from-scenario-xml.mjs neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml',
    '  node scripts/test-script-generator/generate-tests-from-scenario-xml.mjs --all --scenario-dir neo/interactions --out-dir temp/testfiles',
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
    xsdPath: null,
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

    if (token === '--xsd') {
      options.xsdPath = args.shift() || null
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
  const xsdPath = options.xsdPath || fallbackXsdPath

  let scenarioPath = options.scenarioPath
  if (!options.all && !scenarioPath) {
    scenarioPath = defaults.scenario_path_xml
      || defaults.scenario_xml_path
      || join(scenarioDir, 'login.xml')
  }

  return {
    ...options,
    scenarioDir,
    outDir,
    xsdPath,
    scenarioPath,
  }
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

function resolveTemplateString(text, context, dataFunctions = {}) {
  if (typeof text !== 'string') {
    return text
  }

  return text.replace(/{{\s*([^}]+)\s*}}/g, (_, pathExpr) => {
    const expr = String(pathExpr || '').trim()
    if (!expr) {
      return ''
    }

    const funcMatch = expr.match(/^(\w+)\s*\(\s*\)$/)
    if (funcMatch) {
      const funcName = funcMatch[1]
      if (typeof dataFunctions[funcName] === 'function') {
        try {
          const result = dataFunctions[funcName]()
          return result == null ? '' : String(result)
        } catch (error) {
          console.warn(`Error calling data function ${funcName}: ${error.message}`)
          return ''
        }
      }
      return ''
    }

    const value = expr.split('.').reduce((acc, key) => {
      if (acc && Object.prototype.hasOwnProperty.call(acc, key)) {
        return acc[key]
      }
      return undefined
    }, context)

    return value == null ? `{{${expr}}}` : String(value)
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

function resolveDataSection(data, dataFunctions = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {}
  }

  const resolved = {}
  const context = { ...data }

  for (const [key, value] of Object.entries(data)) {
    const resolvedValue = resolveTemplatesDeep(value, context, dataFunctions)
    resolved[key] = resolvedValue
    context[key] = resolvedValue
  }

  return resolved
}

function deriveAppRootAbsolutePath(scenarioPath) {
  const relativeScenario = String(relative(workspaceRoot, resolve(scenarioPath))).replace(/\\/g, '/')
  const markers = ['/interactions/', '/tests/']

  for (const marker of markers) {
    const markerIndex = relativeScenario.indexOf(marker)
    if (markerIndex > 0) {
      const appRootRelative = relativeScenario.slice(0, markerIndex)
      return resolve(workspaceRoot, appRootRelative)
    }
  }

  return null
}

function deriveEnvFillStrategiesAbsolutePath(scenarioPath) {
  const appRoot = deriveAppRootAbsolutePath(scenarioPath)
  if (!appRoot) {
    return null
  }

  return resolve(appRoot, 'env', 'fill-strategies.mjs')
}

function deriveEnvDataFunctionsAbsolutePath(scenarioPath) {
  const appRoot = deriveAppRootAbsolutePath(scenarioPath)
  if (!appRoot) {
    return null
  }

  return resolve(appRoot, 'env', 'data-functions.mjs')
}

async function loadDataFunctions(scenarioPath) {
  const allFunctions = { ...centralDataFunctions }

  const envDataFunctionsAbsolutePath = deriveEnvDataFunctionsAbsolutePath(scenarioPath)
  if (envDataFunctionsAbsolutePath) {
    try {
      const module = await import(envDataFunctionsAbsolutePath)
      const exported = module?.dataFunctions ?? module?.default ?? {}
      if (exported && typeof exported === 'object') {
        Object.assign(allFunctions, exported)
      }
    } catch {
      // ignore if app-specific data functions do not exist
    }
  }

  return allFunctions
}

function getNodeTag(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null
  }

  for (const key of Object.keys(node)) {
    if (key === ':@' || key === '#text' || key === '#comment' || key === '#cdata') {
      continue
    }

    if (key.startsWith('?')) {
      continue
    }

    return key
  }

  return null
}

function normalizeAttributeRecord(rawAttributes) {
  const attrs = {}
  for (const [key, value] of Object.entries(rawAttributes || {})) {
    const normalizedKey = String(key || '').replace(/^@_/, '')
    attrs[normalizedKey] = value == null ? '' : String(value)
  }
  return attrs
}

function toElementTreeFromNode(node) {
  const tag = getNodeTag(node)
  if (!tag) {
    return null
  }

  const attrs = normalizeAttributeRecord(node[':@'] || {})
  const rawChildren = Array.isArray(node[tag]) ? node[tag] : []
  const children = []
  const textParts = []

  for (const rawChild of rawChildren) {
    if (!rawChild || typeof rawChild !== 'object') {
      continue
    }

    if (Object.prototype.hasOwnProperty.call(rawChild, '#text')) {
      textParts.push(String(rawChild['#text'] ?? ''))
      continue
    }

    if (Object.prototype.hasOwnProperty.call(rawChild, '#cdata')) {
      textParts.push(String(rawChild['#cdata'] ?? ''))
      continue
    }

    const childTag = getNodeTag(rawChild)
    if (!childTag) {
      continue
    }

    const childElement = toElementTreeFromNode(rawChild)
    if (childElement) {
      children.push(childElement)
    }
  }

  return {
    tag,
    attrs,
    text: textParts.join(''),
    children,
  }
}

function toPreserveOrderNode(element) {
  const attrs = {}
  for (const [key, value] of Object.entries(element.attrs || {})) {
    attrs[`@_${key}`] = value == null ? '' : String(value)
  }

  const payload = []
  const textValue = element.text == null ? '' : String(element.text)
  if (textValue.trim().length > 0) {
    payload.push({ '#text': textValue })
  }

  for (const child of element.children || []) {
    payload.push(toPreserveOrderNode(child))
  }

  const node = {
    [element.tag]: payload,
  }

  if (Object.keys(attrs).length > 0) {
    node[':@'] = attrs
  }

  return node
}

async function loadXmlDocument(filePath) {
  const source = await readFile(filePath, 'utf8')
  const parsed = parser.parse(source)
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid XML structure in ${filePath}`)
  }

  const rootNode = parsed.find((node) => getNodeTag(node))
  if (!rootNode) {
    throw new Error(`No root XML element found in ${filePath}`)
  }

  const root = toElementTreeFromNode(rootNode)
  if (!root) {
    throw new Error(`Could not parse XML root in ${filePath}`)
  }

  return { source, root }
}

function cloneElement(element) {
  return {
    tag: element.tag,
    attrs: { ...(element.attrs || {}) },
    text: String(element.text || ''),
    children: (element.children || []).map(cloneElement),
  }
}

function resolveElementTemplates(element, context, dataFunctions) {
  return {
    tag: element.tag,
    attrs: resolveTemplatesDeep(element.attrs || {}, context, dataFunctions),
    text: resolveTemplateString(String(element.text || ''), context, dataFunctions),
    children: (element.children || []).map((child) => resolveElementTemplates(child, context, dataFunctions)),
  }
}

function findFirstChild(element, tagName) {
  return (element.children || []).find((child) => child.tag === tagName) || null
}

function findChildren(element, tagName) {
  return (element.children || []).filter((child) => child.tag === tagName)
}

function extractRawDataObject(rootElement) {
  const dataObject = {}
  const daten = findFirstChild(rootElement, 'Daten')
  if (!daten) {
    return dataObject
  }

  for (const entry of daten.children || []) {
    if (entry.tag === 'Wert') {
      const name = String(entry.attrs?.name || '').trim()
      if (!name) {
        continue
      }
      const value = entry.attrs?.value != null ? entry.attrs.value : String(entry.text || '')
      setPathValue(dataObject, name, value)
      continue
    }

    if (entry.tag === 'Datensatz') {
      const datasetName = String(entry.attrs?.name || '').trim()
      if (!datasetName) {
        continue
      }

      for (const valueNode of entry.children || []) {
        if (valueNode.tag !== 'Wert') {
          continue
        }

        const valueName = String(valueNode.attrs?.name || '').trim()
        if (!valueName) {
          continue
        }

        const value = valueNode.attrs?.value != null ? valueNode.attrs.value : String(valueNode.text || '')
        setPathValue(dataObject, `${datasetName}.${valueName}`, value)
      }
    }
  }

  return dataObject
}

function parseBooleanLike(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['true', '1', 'yes', 'ja'].includes(normalized)) {
    return true
  }
  if (['false', '0', 'no', 'nein'].includes(normalized)) {
    return false
  }
  return null
}

function coerceScalar(rawValue) {
  const text = String(rawValue ?? '').trim()
  if (!text.length) {
    return ''
  }

  const boolValue = parseBooleanLike(text)
  if (boolValue != null) {
    return boolValue
  }

  if (/^-?\d+$/.test(text)) {
    return Number(text)
  }

  return text
}

function parseSettingsGroup(groupElement) {
  const out = {}

  for (const child of groupElement.children || []) {
    if (child.tag === 'Einstellung') {
      const name = String(child.attrs?.name || '').trim()
      if (!name) {
        continue
      }
      out[name] = coerceScalar(child.attrs?.value ?? child.text)
      continue
    }

    if (child.tag === 'Gruppe') {
      const groupName = String(child.attrs?.name || '').trim()
      if (!groupName) {
        continue
      }
      out[groupName] = parseSettingsGroup(child)
    }
  }

  return out
}

function extractSettings(rootElement) {
  const settingsRoot = findFirstChild(rootElement, 'Einstellungen')
  if (!settingsRoot) {
    return {}
  }

  const out = {}
  for (const child of settingsRoot.children || []) {
    if (child.tag === 'Einstellung') {
      const name = String(child.attrs?.name || '').trim()
      if (!name) {
        continue
      }
      out[name] = coerceScalar(child.attrs?.value ?? child.text)
      continue
    }

    if (child.tag === 'Gruppe') {
      const groupName = String(child.attrs?.name || '').trim()
      if (!groupName) {
        continue
      }
      out[groupName] = parseSettingsGroup(child)
    }
  }

  return out
}

function getFragmentParameterNames(fragmentRootElement) {
  const variablenElement = findFirstChild(fragmentRootElement, 'Variablen')
  if (!variablenElement) {
    return []
  }

  return (variablenElement.children || [])
    .filter((entry) => entry.tag === 'Variable')
    .map((entry) => String(entry.attrs?.name || '').trim())
    .filter(Boolean)
}

function buildParameterContext(parameterElements, parentContext, dataFunctions) {
  const overrides = {}

  for (const parameter of parameterElements || []) {
    if (parameter.tag !== 'Parameter') {
      continue
    }

    const name = String(parameter.attrs?.name || '').trim()
    if (!name) {
      continue
    }

    const rawValue = parameter.attrs?.value != null ? parameter.attrs.value : String(parameter.text || '')
    const resolvedValue = resolveTemplateString(String(rawValue), parentContext, dataFunctions)
    setPathValue(overrides, name, resolvedValue)
  }

  return overrides
}

function hasContextParameter(context, parameterName) {
  if (Object.prototype.hasOwnProperty.call(context, parameterName)) {
    return true
  }

  return getPathValue(context, parameterName) !== undefined
}

async function fileExists(filePath) {
  try {
    const fileStat = await stat(filePath)
    return fileStat.isFile()
  } catch {
    return false
  }
}

async function buildFragmentIndex(scenarioPath) {
  const appRoot = deriveAppRootAbsolutePath(scenarioPath)
  if (!appRoot) {
    return new Map()
  }

  const candidateDirs = [
    resolve(appRoot, 'fragements'),
    resolve(appRoot, 'fragments'),
  ]

  const existingDirs = []
  for (const dir of candidateDirs) {
    try {
      const dirStat = await stat(dir)
      if (dirStat.isDirectory()) {
        existingDirs.push(dir)
      }
    } catch {
      // ignore
    }
  }

  const index = new Map()

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }

      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.xml') {
        continue
      }

      const registerKey = (rawKey) => {
        const key = String(rawKey || '').trim()
        if (!key) {
          return
        }

        if (!index.has(key)) {
          index.set(key, [])
        }

        const list = index.get(key)
        if (!list.includes(absolute)) {
          list.push(absolute)
        }
      }

      registerKey(basename(entry.name, '.xml'))

      try {
        const xmlSource = await readFile(absolute, 'utf8')
        const idMatch = xmlSource.match(/<SzenarioScript\b[^>]*\bid\s*=\s*"([^"]+)"/i)
        if (idMatch && idMatch[1]) {
          registerKey(idMatch[1])
        }
      } catch {
        // keep basename registration only if reading/parsing fails
      }
    }
  }

  for (const dir of existingDirs) {
    await walk(dir)
  }

  return index
}

function chooseFragmentPath(fragmentName, fragmentIndex) {
  const normalizedName = String(fragmentName || '').trim()
  const candidates = fragmentIndex.get(normalizedName) || []
  if (!candidates.length) {
    const suffix = normalizedName.includes('-')
      ? normalizedName.split('-').filter(Boolean).slice(-1)[0]
      : ''

    if (suffix) {
      const suffixCandidates = fragmentIndex.get(suffix) || []
      if (suffixCandidates.length > 0) {
        return suffixCandidates.slice().sort((left, right) => left.localeCompare(right))[0]
      }
    }

    return null
  }

  if (candidates.length > 1) {
    candidates.sort((left, right) => left.localeCompare(right))
  }

  return candidates[0]
}

function mapWaitStatusToState(statusRaw) {
  const status = String(statusRaw || '').trim().toLowerCase()
  if (!status) {
    return {}
  }

  if (status === 'sichtbar') {
    return { visible: true }
  }

  if (status === 'nicht-sichtbar') {
    return { visible: false }
  }

  if (status === 'vorhanden') {
    return { visible: true }
  }

  if (status === 'nicht-vorhanden') {
    return { visible: false }
  }

  if (status === 'aktiviert') {
    return { disabled: 'false' }
  }

  if (status === 'deaktiviert') {
    return { disabled: 'true' }
  }

  return {}
}

function buildTargetFromAttributes(attrs, { includeText = true, includeUrl = false } = {}) {
  const target = {}

  if (attrs['data-id']) {
    target['data-id'] = attrs['data-id']
  }

  if (attrs.id) {
    target.id = attrs.id
  }

  if (attrs.label) {
    target.label = attrs.label
  }

  if (attrs['aria-label']) {
    target['aria-label'] = attrs['aria-label']
  }

  if (includeText && attrs.text) {
    target.text = attrs.text
  }

  if (includeUrl && attrs.url) {
    target.url = attrs.url
  }

  return target
}

function sanitizeIdPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function createStepIdFactory() {
  const counters = new Map()

  return (element, fallbackPrefix = 'step') => {
    const explicitId = String(element.attrs?.id || '').trim()
    const base = sanitizeIdPart(explicitId)
      || sanitizeIdPart(element.attrs?.['data-id'])
      || sanitizeIdPart(element.attrs?.text)
      || sanitizeIdPart(`${fallbackPrefix}-${element.tag}`)
      || 'step'

    const currentCount = (counters.get(base) || 0) + 1
    counters.set(base, currentCount)

    return currentCount === 1 ? base : `${base}-${currentCount}`
  }
}

function isInteractionElement(element) {
  return INTERACTION_TAGS.has(element.tag)
}

function buildResolvedInteractionTitle(element) {
  const attrs = element?.attrs || {}
  const parts = [String(element?.tag || 'Interaction')]

  for (const attrName of RESOLVED_TITLE_SOURCE_ATTRS) {
    const value = attrs[attrName]
    if (value == null) {
      continue
    }

    const text = String(value).replace(/\s+/g, ' ').trim()
    if (!text) {
      continue
    }

    parts.push(`${attrName}=${text}`)
  }

  const inlineText = String(element?.text || '').replace(/\s+/g, ' ').trim()
  if (inlineText) {
    parts.push(`value=${inlineText}`)
  }

  const title = parts.join(' | ')
  return title.length > 220 ? `${title.slice(0, 217)}...` : title
}

function annotateResolvedInteractionMetadata(rootElement) {
  let sequence = 0

  function visit(node) {
    if (!node || typeof node !== 'object') {
      return
    }

    if (isInteractionElement(node)) {
      sequence += 1
      const resolvedId = `R${String(sequence).padStart(4, '0')}`
      const resolvedTitle = buildResolvedInteractionTitle(node)

      node.attrs = {
        ...(node.attrs || {}),
        'resolved-id': resolvedId,
        'resolved-title': resolvedTitle,
      }
    }

    for (const child of node.children || []) {
      visit(child)
    }
  }

  visit(rootElement)
  return rootElement
}

function mapInteractionElementToStep(element, makeStepId) {
  const tag = element.tag
  const attrs = element.attrs || {}
  const trimmedText = String(element.text || '').trim()
  const resolvedId = String(attrs['resolved-id'] || '').trim()
  const resolvedTitle = String(attrs['resolved-title'] || '').trim()

  function withResolvedMeta(step) {
    if (resolvedId) {
      step.resolvedId = resolvedId
    }
    if (resolvedTitle) {
      step.resolvedTitle = resolvedTitle
    }
    return step
  }

  if (tag === 'Click') {
    return withResolvedMeta({
      id: makeStepId(element, 'click'),
      interaction: {
        type: 'click',
        target: buildTargetFromAttributes(attrs, { includeText: true }),
      },
    })
  }

  if (tag === 'Eingabe') {
    const value = trimmedText || String(attrs.text || '')
    return withResolvedMeta({
      id: makeStepId(element, 'fill'),
      interaction: {
        type: 'fill',
        target: buildTargetFromAttributes(attrs, { includeText: false }),
        value,
      },
    })
  }

  if (tag === 'Auswahl') {
    const value = trimmedText || String(attrs.text || '')
    return withResolvedMeta({
      id: makeStepId(element, 'select'),
      interaction: {
        type: 'select',
        target: buildTargetFromAttributes(attrs, { includeText: false }),
        value,
      },
    })
  }

  if (tag === 'Anzeige') {
    return withResolvedMeta({
      id: makeStepId(element, 'show'),
      interaction: {
        type: 'click',
        target: buildTargetFromAttributes(attrs, { includeText: true }),
      },
    })
  }

  if (tag === 'Warten') {
    const interaction = {
      type: 'wait',
    }

    const target = buildTargetFromAttributes(attrs, { includeText: true, includeUrl: true })
    if (Object.keys(target).length > 0) {
      interaction.target = target
    }

    const state = mapWaitStatusToState(attrs.status)
    if (Object.keys(state).length > 0) {
      interaction.state = state
    }

    if (attrs['timeout-ms']) {
      interaction.timeout_ms = Number(attrs['timeout-ms'])
    }

    if (!interaction.target && Number.isFinite(interaction.timeout_ms)) {
      interaction.ms = interaction.timeout_ms
      delete interaction.timeout_ms
    }

    return withResolvedMeta({
      id: makeStepId(element, 'wait'),
      interaction,
    })
  }

  if (tag === 'Oeffnen') {
    const url = attrs.url || trimmedText
    return withResolvedMeta({
      id: makeStepId(element, 'open'),
      interaction: {
        type: 'open',
        target: {
          url,
        },
      },
    })
  }

  if (tag === 'SucheAuswahl') {
    return withResolvedMeta({
      id: makeStepId(element, 'search-select'),
      interaction: {
        type: 'search-and-select',
        target: buildTargetFromAttributes(attrs, { includeText: false }),
        value: attrs.suchwert || trimmedText,
        resultSelector: attrs['result-selector'] || '.q-menu .q-item',
        resultIndex: attrs['treffer-index'] != null ? Number(attrs['treffer-index']) : 0,
      },
    })
  }

  return null
}

function mapWennCondition(element) {
  const attrs = element.attrs || {}
  const target = buildTargetFromAttributes(attrs, { includeText: true, includeUrl: true })
  const state = {
    ...mapWaitStatusToState(attrs.status),
  }

  if (attrs['attribut']) {
    const attributeName = String(attrs['attribut']).trim()
    if (attributeName) {
      state[attributeName] = attrs['attribut-wert'] ?? 'true'
    }
  }

  if (attrs['timeout-ms']) {
    state.wait_ms = Number(attrs['timeout-ms'])
  }

  return {
    target,
    state,
  }
}

function splitWennBranches(element) {
  const thenChildren = []
  const elseChildren = []
  const directChildren = Array.isArray(element?.children) ? element.children : []
  let sawElse = false

  for (const child of directChildren) {
    if (child?.tag === 'Sonst') {
      sawElse = true
      elseChildren.push(...(Array.isArray(child.children) ? child.children : []))
      continue
    }

    if (sawElse) {
      elseChildren.push(child)
    } else {
      thenChildren.push(child)
    }
  }

  return {
    thenChildren,
    elseChildren,
  }
}

function flowFromInteractionTree(children, makeStepId) {
  const flow = []

  for (const child of children || []) {
    if (child.tag === 'Gruppe') {
      flow.push(...flowFromInteractionTree(child.children || [], makeStepId))
      continue
    }

    if (child.tag === 'Wenn') {
      const condition = mapWennCondition(child)
      const { thenChildren, elseChildren } = splitWennBranches(child)
      const thenFlow = flowFromInteractionTree(thenChildren, makeStepId)
      const elseFlow = flowFromInteractionTree(elseChildren, makeStepId)

      if (thenFlow.length > 0 || elseFlow.length > 0) {
        flow.push({
          id: makeStepId(child, 'if'),
          condition,
          flow: thenFlow,
          elseFlow,
        })
      }

      continue
    }

    if (!isInteractionElement(child)) {
      continue
    }

    const mappedStep = mapInteractionElementToStep(child, makeStepId)
    if (mappedStep) {
      flow.push(mappedStep)
    }
  }

  return flow
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

    if (Array.isArray(step.elseFlow) && step.elseFlow.length > 0) {
      collectFlowStepIds(step.elseFlow, out)
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

async function expandFragmentsInChildren(children, { context, dataFunctions, fragmentIndex, includeStack = [] }) {
  const expanded = []

  for (const child of children || []) {
    if (child.tag === 'Fragment') {
      const fragmentName = String(child.attrs?.name || '').trim()
      if (!fragmentName) {
        throw new Error('Fragment element requires a non-empty name attribute.')
      }

      const fragmentPath = chooseFragmentPath(fragmentName, fragmentIndex)
      if (!fragmentPath) {
        throw new Error(`Fragment "${fragmentName}" not found below app fragment directories.`)
      }

      if (includeStack.includes(fragmentPath)) {
        throw new Error(`Circular fragment include detected: ${[...includeStack, fragmentPath].join(' -> ')}`)
      }

      const fragmentDocument = await loadXmlDocument(fragmentPath)
      if (fragmentDocument.root.tag !== 'SzenarioScript') {
        throw new Error(`Fragment file "${fragmentPath}" must have root <SzenarioScript>.`)
      }

      const fragmentParameters = getFragmentParameterNames(fragmentDocument.root)
      const parameterContext = buildParameterContext(child.children || [], context, dataFunctions)
      const fragmentContext = {
        ...context,
        ...parameterContext,
      }

      for (const parameterName of fragmentParameters) {
        if (!hasContextParameter(fragmentContext, parameterName)) {
          throw new Error(`Missing fragment parameter "${parameterName}" for fragment "${fragmentName}" in ${fragmentPath}`)
        }
      }

      const fragmentGroups = findChildren(fragmentDocument.root, 'Gruppe')
      const fragmentPayloadChildren = []
      for (const group of fragmentGroups) {
        fragmentPayloadChildren.push(...(group.children || []))
      }

      const nestedExpansion = await expandFragmentsInChildren(fragmentPayloadChildren, {
        context: fragmentContext,
        dataFunctions,
        fragmentIndex,
        includeStack: [...includeStack, fragmentPath],
      })

      expanded.push(...nestedExpansion)
      continue
    }

    const clonedChild = cloneElement(child)
    const expandedNestedChildren = await expandFragmentsInChildren(clonedChild.children || [], {
      context,
      dataFunctions,
      fragmentIndex,
      includeStack,
    })

    clonedChild.children = expandedNestedChildren
    const resolvedChild = resolveElementTemplates(clonedChild, context, dataFunctions)
    expanded.push(resolvedChild)
  }

  return expanded
}

function buildResolvedDataElement(resolvedData) {
  const dataChildren = []

  for (const [key, value] of Object.entries(resolvedData || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const recordChildren = []
      for (const [subKey, subValue] of Object.entries(value)) {
        recordChildren.push({
          tag: 'Wert',
          attrs: {
            name: subKey,
            value: subValue == null ? '' : String(subValue),
          },
          text: '',
          children: [],
        })
      }

      dataChildren.push({
        tag: 'Datensatz',
        attrs: {
          name: key,
        },
        text: '',
        children: recordChildren,
      })
      continue
    }

    dataChildren.push({
      tag: 'Wert',
      attrs: {
        name: key,
        value: value == null ? '' : String(value),
      },
      text: '',
      children: [],
    })
  }

  return {
    tag: 'Daten',
    attrs: {},
    text: '',
    children: dataChildren,
  }
}

function upsertResolvedData(rootElement, resolvedData) {
  const nextRoot = cloneElement(rootElement)
  const rebuiltData = buildResolvedDataElement(resolvedData)

  const existingIndex = (nextRoot.children || []).findIndex((child) => child.tag === 'Daten')
  if (existingIndex >= 0) {
    nextRoot.children[existingIndex] = rebuiltData
  } else {
    nextRoot.children.unshift(rebuiltData)
  }

  return nextRoot
}

async function validateXmlAgainstXsd(xmlPath, xsdPath) {
  if (!(await fileExists(xsdPath))) {
    throw new Error(`XSD file not found: ${xsdPath}`)
  }

  try {
    await execFileAsync('xmllint', ['--noout', '--schema', xsdPath, xmlPath])
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('xmllint is required for XSD validation but was not found. Install libxml2-utils (Debian/Ubuntu) or libxml2.')
    }

    const stderrText = String(error?.stderr || '').trim()
    const stdoutText = String(error?.stdout || '').trim()
    const details = [stderrText, stdoutText].filter(Boolean).join('\n')
    throw new Error(`XML failed XSD validation for ${xmlPath}:\n${details || error.message}`)
  }
}

function composeResolvedXmlSource(resolvedRootElement) {
  const payload = [toPreserveOrderNode(resolvedRootElement)]
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(payload)}`
}

async function scenarioToSpecSource({ scenarioPath, xsdPath, centralConfig, generatedSpecPath }) {
  const absoluteScenarioPath = resolve(workspaceRoot, scenarioPath)
  const absoluteXsdPath = resolve(workspaceRoot, xsdPath)

  await validateXmlAgainstXsd(absoluteScenarioPath, absoluteXsdPath)

  const scenarioDocument = await loadXmlDocument(absoluteScenarioPath)
  if (scenarioDocument.root.tag !== 'SzenarioScript') {
    throw new Error('Scenario XML root must be <SzenarioScript>.')
  }

  const dataFunctions = await loadDataFunctions(absoluteScenarioPath)
  const rawData = extractRawDataObject(scenarioDocument.root)
  const resolvedData = resolveDataSection(rawData, dataFunctions)
  const settings = extractSettings(scenarioDocument.root)

  const fragmentIndex = await buildFragmentIndex(absoluteScenarioPath)
  const expandedChildren = await expandFragmentsInChildren(scenarioDocument.root.children || [], {
    context: { ...resolvedData },
    dataFunctions,
    fragmentIndex,
  })

  const expandedRoot = {
    ...cloneElement(scenarioDocument.root),
    children: expandedChildren,
  }

  const resolvedRootElement = upsertResolvedData(
    resolveElementTemplates(expandedRoot, { ...resolvedData }, dataFunctions),
    resolvedData,
  )
  annotateResolvedInteractionMetadata(resolvedRootElement)

  const makeStepId = createStepIdFactory()
  const topLevelGroups = findChildren(resolvedRootElement, 'Gruppe')
  const flow = []
  for (const group of topLevelGroups) {
    flow.push(...flowFromInteractionTree(group.children || [], makeStepId))
  }

  const xmlVideo = settings.video && typeof settings.video === 'object' ? settings.video : {}
  const rootVideo = {
    ...(centralConfig?.video || {}),
    ...(xmlVideo || {}),
  }

  const resolvedRoot = {
    id: resolvedRootElement.attrs?.id || basename(absoluteScenarioPath, extname(absoluteScenarioPath)),
    version: resolvedRootElement.attrs?.['szenario-version'] || 'unknown',
    video: rootVideo,
    data: resolvedData,
    flow,
  }

  if (!resolvedRoot.flow.length) {
    throw new Error('Scenario contains no interaction steps after XML reduction.')
  }

  assertUniqueFlowStepIds(resolvedRoot.flow, absoluteScenarioPath)

  const envFillStrategiesAbsolutePath = deriveEnvFillStrategiesAbsolutePath(absoluteScenarioPath)
  const envFillStrategiesImportPath = envFillStrategiesAbsolutePath && await fileExists(envFillStrategiesAbsolutePath)
    ? `./${getScenarioEnvFillStrategiesFilename(generatedSpecPath)}`
    : null

  const specSource = renderScenarioSpecTemplate({
    resolvedRoot,
    scenarioPathRelative: relative(workspaceRoot, absoluteScenarioPath),
    envFillStrategiesImportPath,
  })

  return {
    specSource,
    resolvedRoot,
    resolvedXmlSource: composeResolvedXmlSource(resolvedRootElement),
    envFillStrategiesAbsolutePath,
  }
}

function getResolvedJsonOutputPath(specOutputPath) {
  if (specOutputPath.endsWith('.spec.js')) {
    return specOutputPath.slice(0, -'.spec.js'.length) + '.resolved.json'
  }
  return `${specOutputPath}.resolved.json`
}

function getResolvedXmlOutputPath(specOutputPath) {
  if (specOutputPath.endsWith('.spec.js')) {
    return specOutputPath.slice(0, -'.spec.js'.length) + '.test-resolved.xml'
  }
  return `${specOutputPath}..test-resolved.xml`
}

function getScenarioSupportPaths(specOutputPath) {
  const specDir = dirname(specOutputPath)
  const supportFilenames = getScenarioSpecSupportFilenames()

  return {
    scenarioHelpersPath: join(specDir, supportFilenames.scenarioHelpers),
    envFillStrategiesPath: join(specDir, getScenarioEnvFillStrategiesFilename(specOutputPath)),
    scenarioRuntimePath: join(specDir, supportFilenames.scenarioRuntime),
    centralFillStrategiesPath: join(specDir, supportFilenames.centralFillStrategies),
    extractPdfCodePath: join(specDir, supportFilenames.extractPdfCode),
  }
}

async function writeScenarioSupportFiles({ specOutputPath, envFillStrategiesAbsolutePath }) {
  const supportPaths = getScenarioSupportPaths(specOutputPath)

  await cp(
    resolve(workspaceRoot, 'scripts', 'test-script-generator', 'runtime', 'scenario-helpers.mjs'),
    supportPaths.scenarioHelpersPath,
    { force: true },
  )
  await cp(
    resolve(workspaceRoot, 'scripts', 'test-script-generator', 'runtime', 'generated-scenario-runtime.js'),
    supportPaths.scenarioRuntimePath,
    { force: true },
  )
  await cp(
    resolve(workspaceRoot, 'scripts', 'test-script-generator', 'central-fill-strategies.mjs'),
    supportPaths.centralFillStrategiesPath,
    { force: true },
  )
  await cp(
    resolve(workspaceRoot, 'scripts', 'test-script-generator', 'extract-pdf-code.mjs'),
    supportPaths.extractPdfCodePath,
    { force: true },
  )

  if (envFillStrategiesAbsolutePath && await fileExists(envFillStrategiesAbsolutePath)) {
    await cp(envFillStrategiesAbsolutePath, supportPaths.envFillStrategiesPath, { force: true })
  }

  return supportPaths
}

function sanitizeFileToken(value, fallback = 'scenario') {
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

      if (entry.isFile() && extname(entry.name).toLowerCase() === '.xml') {
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
    if (!entry.isFile()) {
      continue
    }

    if (
      entry.name.endsWith('.spec.js')
      || entry.name.endsWith('.spec.js.meta.json')
      || entry.name.endsWith('.helpers.mjs')
      || entry.name.endsWith('.env-fill-strategies.mjs')
      || entry.name.endsWith('.resolved.json')
      || entry.name.endsWith('.test-resolved.xml')
      || entry.name === 'scenario-helpers.mjs'
      || entry.name === 'generated-scenario-runtime.js'
      || entry.name === 'central-fill-strategies.mjs'
      || entry.name === 'extract-pdf-code.mjs'
    ) {
      await rm(join(outDirPath, entry.name), { force: true })
    }
  }
}

async function generateOne(scenarioFilePath, outDirPath, options, centralConfig) {
  const xmlStats = await stat(scenarioFilePath)

  const outputBaseName = `${basename(scenarioFilePath, extname(scenarioFilePath))}.spec.js`
  const outputPath = join(outDirPath, outputBaseName)

  const { specSource, resolvedRoot, resolvedXmlSource, envFillStrategiesAbsolutePath } = await scenarioToSpecSource({
    scenarioPath: scenarioFilePath,
    xsdPath: options.xsdPath,
    centralConfig,
    generatedSpecPath: outputPath,
  })

  const metaPath = `${outputPath}.meta.json`
  const resolvedJsonPath = getResolvedJsonOutputPath(outputPath)
  const resolvedXmlPath = getResolvedXmlOutputPath(outputPath)

  await writeFile(outputPath, specSource, 'utf8')
  const supportPaths = await writeScenarioSupportFiles({
    specOutputPath: outputPath,
    envFillStrategiesAbsolutePath,
  })
  await writeFile(resolvedJsonPath, JSON.stringify({ interaction: resolvedRoot }, null, 2), 'utf8')
  await writeFile(resolvedXmlPath, resolvedXmlSource, 'utf8')
  await writeFile(
    metaPath,
    JSON.stringify({
      generatedAtIso: new Date().toISOString(),
      generatedAtMs: Date.now(),
      scenarioPathRelative: relative(workspaceRoot, resolve(scenarioFilePath)),
      xsdPathRelative: relative(workspaceRoot, resolve(options.xsdPath)),
      resolvedJsonPathRelative: relative(workspaceRoot, resolvedJsonPath),
      resolvedXmlPathRelative: relative(workspaceRoot, resolvedXmlPath),
      sourceXmlMtimeIso: xmlStats.mtime.toISOString(),
      sourceXmlMtimeMs: xmlStats.mtimeMs,
    }, null, 2),
    'utf8',
  )

  const scenarioFolderName = buildScenarioOutputFolderName({
    scenarioId: resolvedRoot.id,
    scenarioVersion: resolvedRoot.version,
  })
  const scenarioOutputGeneratedDir = resolve(workspaceRoot, 'output', scenarioFolderName, 'generated')
  await mkdir(scenarioOutputGeneratedDir, { recursive: true })
  await rm(
    join(
      scenarioOutputGeneratedDir,
      `${basename(outputPath, '.spec.js')}.helpers.mjs`,
    ),
    { force: true },
  )
  await cp(outputPath, join(scenarioOutputGeneratedDir, basename(outputPath)), { force: true })
  await cp(supportPaths.scenarioHelpersPath, join(scenarioOutputGeneratedDir, basename(supportPaths.scenarioHelpersPath)), { force: true })
  if (await fileExists(supportPaths.envFillStrategiesPath)) {
    await cp(supportPaths.envFillStrategiesPath, join(scenarioOutputGeneratedDir, basename(supportPaths.envFillStrategiesPath)), { force: true })
  }
  await cp(supportPaths.scenarioRuntimePath, join(scenarioOutputGeneratedDir, basename(supportPaths.scenarioRuntimePath)), { force: true })
  await cp(supportPaths.centralFillStrategiesPath, join(scenarioOutputGeneratedDir, basename(supportPaths.centralFillStrategiesPath)), { force: true })
  await cp(supportPaths.extractPdfCodePath, join(scenarioOutputGeneratedDir, basename(supportPaths.extractPdfCodePath)), { force: true })
  await cp(resolvedJsonPath, join(scenarioOutputGeneratedDir, basename(resolvedJsonPath)), { force: true })
  await cp(resolvedXmlPath, join(scenarioOutputGeneratedDir, basename(resolvedXmlPath)), { force: true })
  await cp(metaPath, join(scenarioOutputGeneratedDir, basename(metaPath)), { force: true })

  return outputPath
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

  const outDirPath = resolve(workspaceRoot, options.outDir)
  if (options.clean) {
    await cleanOutputDirectory(outDirPath)
    console.log(`Cleaned generated spec files in ${relative(workspaceRoot, outDirPath)}`)
    return
  }

  const scenarioFiles = await collectScenarioFiles(options)
  if (!scenarioFiles.length) {
    throw new Error('No scenario xml files found.')
  }

  await mkdir(outDirPath, { recursive: true })

  const written = []
  for (const scenarioFilePath of scenarioFiles) {
    const outputPath = await generateOne(scenarioFilePath, outDirPath, options, testScriptConfig)
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
