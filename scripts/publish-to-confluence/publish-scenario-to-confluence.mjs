#!/usr/bin/env node

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { Buffer } from 'buffer'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'
import { buildScenarioOutputFolderName } from '../shared/scenario-output.mjs'
import { getTestScriptConfig, loadCentralConfig } from '../shared/central-config.mjs'
import { scenarioToSpecSource } from '../test-script-generator/generate-tests-from-scenario-xml.mjs'

const execFileAsync = promisify(execFile)
const CREDENTIALS_ENV_NAME = 'CONFLUENCE_PUBLISHHELPER_CREDENTIALS'
const MANAGED_BLOCK_START = '<!-- lumiere-publishhelper:start -->'
const MANAGED_BLOCK_END = '<!-- lumiere-publishhelper:end -->'
const DEFAULT_XSD_PATH = resolve(process.cwd(), 'schemas', 'szenarioscript.xsd')
const TIMELINE_INTERACTION_TAGS = new Set([
  'Click',
  'Eingabe',
  'Auswahl',
  'Upload',
  'Anzeige',
  'Auslesen',
  'PdfCodeAuslesen',
  'GET',
  'POST',
  'PinBriefMailAuslesen',
  'Warten',
  'Oeffnen',
  'SucheAuswahl',
])
const CONTAINER_TAGS = new Set(['SzenarioScript', 'Gruppe', 'Wenn', 'Sonst'])

function printUsage() {
  console.log(`Verwendung:
  node scripts/publish-to-confluence/publish-scenario-to-confluence.mjs <szenarioscript.xml> [confluence-page-id] --scenario-id=<id>

Voraussetzungen:
  - Es existieren Timeline, Rohvideo und Timeline-Screenshots fuer das Szenario
  - Optional: Es existiert ein Schulungsvideo fuer das Szenario
  - ${CREDENTIALS_ENV_NAME} ist gesetzt
`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function normalizeWorkspaceRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim()
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function toCdataSafe(value) {
  return String(value || '').replaceAll(']]>', ']]]]><![CDATA[>')
}

function readTextNode(children = []) {
  return children
    .map((entry) => {
      if (entry && typeof entry === 'object' && typeof entry['#text'] === 'string') {
        return entry['#text']
      }
      return ''
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function getNodeTag(node) {
  if (!node || typeof node !== 'object') {
    return null
  }
  return Object.keys(node).find((key) => key !== ':@') || null
}

function getNodeChildren(node) {
  const tag = getNodeTag(node)
  if (!tag) {
    return []
  }
  return Array.isArray(node[tag]) ? node[tag] : []
}

function getNodeAttrs(node) {
  if (!node || typeof node !== 'object') {
    return {}
  }
  return node[':@'] && typeof node[':@'] === 'object' ? node[':@'] : {}
}

function parseScenarioMetaFromRawXml(xmlRaw) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })

  const parsed = parser.parse(xmlRaw)
  const root = parsed?.SzenarioScript
  if (!root || typeof root !== 'object') {
    throw new Error('Ungueltiges Szenarioscript: Wurzelknoten <SzenarioScript> fehlt.')
  }

  const title = String(root['@_titel'] || '').trim()
  const version = String(
    root['@_szenario-version']
      || root['@_videoscript-version']
      || root['@_testscript-version']
      || root['@_neo-version-min']
      || 'unknown',
  ).trim() || 'unknown'

  return { title, version }
}

function parseCredentialsFromEnv() {
  const raw = process.env[CREDENTIALS_ENV_NAME]
  if (!raw || !raw.trim()) {
    throw new Error(`Die Umgebungsvariable ${CREDENTIALS_ENV_NAME} fehlt.`)
  }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${CREDENTIALS_ENV_NAME} muss gueltiges JSON sein.`)
  }

  const baseUrl = normalizeBaseUrl(parsed?.baseUrl || parsed?.siteUrl)
  const email = String(parsed?.email || '').trim()
  const apiToken = String(parsed?.apiToken || '').trim()
  const cloudId = String(parsed?.cloudId || '').trim()
  const accessToken = String(parsed?.accessToken || '').trim()

  if (cloudId && accessToken) {
    if (!baseUrl) {
      throw new Error(`${CREDENTIALS_ENV_NAME} braucht im Modus "cloudId"/"accessToken" zusaetzlich "baseUrl" oder "siteUrl".`)
    }

    return {
      mode: 'cloud',
      baseUrl,
      cloudId,
      accessToken,
    }
  }

  if (baseUrl && email && apiToken) {
    return {
      mode: 'basic',
      baseUrl,
      email,
      apiToken,
    }
  }

  throw new Error(
    `${CREDENTIALS_ENV_NAME} muss entweder "cloudId" und "accessToken" oder "baseUrl", "email" und "apiToken" enthalten.`,
  )
}

function buildAuthorizationHeader({ email, apiToken }) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
}

function buildBasicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function buildApiContext(credentials) {
  if (credentials.mode === 'cloud') {
    return {
      pageApiBaseUrl: `https://api.atlassian.com/ex/confluence/${encodeURIComponent(credentials.cloudId)}/wiki/api/v2`,
      attachmentApiBaseUrl: `https://api.atlassian.com/ex/confluence/${encodeURIComponent(credentials.cloudId)}/wiki/rest/api`,
      authHeader: `Bearer ${credentials.accessToken}`,
      authModeLabel: 'cloud',
    }
  }

  return {
    pageApiBaseUrl: `${credentials.baseUrl}/wiki/api/v2`,
    attachmentApiBaseUrl: `${credentials.baseUrl}/wiki/rest/api`,
    authHeader: buildAuthorizationHeader(credentials),
    authModeLabel: 'basic',
  }
}

async function confluenceJsonRequest(url, options, errorPrefix) {
  const response = await fetch(url, options)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${errorPrefix} (${response.status} ${response.statusText}): ${body}`)
  }

  if (response.status === 204) {
    return null
  }

  const responseText = await response.text()
  if (!responseText.trim()) {
    return null
  }

  try {
    return JSON.parse(responseText)
  } catch {
    return responseText
  }
}

async function fetchPage({ pageApiBaseUrl, authHeader, pageId }) {
  const url = `${pageApiBaseUrl}/pages/${encodeURIComponent(pageId)}?body-format=storage&include-version=true`
  const page = await confluenceJsonRequest(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
    },
  }, `Confluence-Seite ${pageId} konnte nicht geladen werden`)

  const title = String(page?.title || '').trim()
  const versionNumber = Number(page?.version?.number)
  const bodyStorage = String(page?.body?.storage?.value || '')
  const spaceId = String(page?.spaceId || '').trim()

  if (!title || !Number.isFinite(versionNumber)) {
    throw new Error(`Confluence-Seite ${pageId} lieferte keine gueltigen Titel-/Versionsdaten.`)
  }

  return {
    title,
    versionNumber,
    bodyStorage,
    spaceId,
  }
}

function extractCommentCount(payload) {
  if (Array.isArray(payload)) {
    return payload.length
  }
  if (!payload || typeof payload !== 'object') {
    return 0
  }
  if (Array.isArray(payload.results)) {
    return payload.results.length
  }
  if (Number.isFinite(Number(payload.size))) {
    return Number(payload.size)
  }
  if (Array.isArray(payload.comments?.results)) {
    return payload.comments.results.length
  }
  if (Number.isFinite(Number(payload.comments?.size))) {
    return Number(payload.comments.size)
  }
  return 0
}

async function assertPageHasNoComments({ attachmentApiBaseUrl, authHeader, pageId }) {
  const url = `${attachmentApiBaseUrl}/content/${encodeURIComponent(pageId)}/child/comment?limit=1`
  const payload = await confluenceJsonRequest(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
    },
  }, `Kommentare der Confluence-Seite ${pageId} konnten nicht geladen werden`)

  if (extractCommentCount(payload) > 0) {
    throw new Error(`Publish abgebrochen: Confluence-Seite ${pageId} enthaelt bereits Kommentare.`)
  }
}

async function createPage({ pageApiBaseUrl, authHeader, title, parentPageId, bodyStorage, spaceId }) {
  const url = `${pageApiBaseUrl}/pages`
  const page = await confluenceJsonRequest(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'current',
      title,
      parentId: String(parentPageId),
      spaceId: String(spaceId),
      body: {
        representation: 'storage',
        value: bodyStorage,
      },
    }),
  }, `Confluence-Seite unter Parent ${parentPageId} konnte nicht angelegt werden`)

  const pageId = String(page?.id || '').trim()
  if (!pageId) {
    throw new Error(`Neu angelegte Confluence-Seite unter Parent ${parentPageId} lieferte keine gueltige ID.`)
  }

  return { pageId }
}

function readLunettesApiContext(software) {
  const workspaceRoot = process.cwd()
  const centralConfig = loadCentralConfig(workspaceRoot, { software })
  const testScriptConfig = centralConfig?.config?.['test-script'] || {}
  const watcherConfig = centralConfig?.config?.['lunettes-job-watcher'] || {}
  const baseUrl = watcherConfig?.base_url
    ? normalizeBaseUrl(watcherConfig.base_url)
    : normalizeBaseUrl(testScriptConfig?.lunettes_api?.base_url)

  if (!baseUrl) {
    throw new Error('Lunettes API base_url fehlt.')
  }

  const username = String(process.env.LUNETTES_API_USERNAME || '').trim()
  const password = String(process.env.LUNETTES_API_PASSWORD || '')
  if (!username || !password) {
    throw new Error('LUNETTES_API_USERNAME oder LUNETTES_API_PASSWORD fehlt fuer die Lunettes-Rueckmeldung der confluence_page_id.')
  }

  return {
    baseUrl,
    authHeader: buildBasicAuthHeader(username, password),
  }
}

function tryReadLunettesApiContext(software) {
  try {
    return readLunettesApiContext(software)
  } catch {
    return null
  }
}

function extractConfluencePageIdFromLunettesPayload(payload) {
  if (payload == null) {
    return null
  }
  if (typeof payload === 'string') {
    const value = payload.trim()
    return value || null
  }

  const candidates = [
    payload?.confluence_page_id,
    payload?.confluencePageId,
    payload?.page_id,
    payload?.pageId,
    payload?.data?.confluence_page_id,
    payload?.data?.confluencePageId,
    payload?.data?.page_id,
    payload?.data?.pageId,
  ]

  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (value) {
      return value
    }
  }

  return null
}

function extractScenarioTitleFromLunettesPayload(payload) {
  if (payload == null || typeof payload !== 'object') {
    return null
  }

  const candidates = [payload?.titel, payload?.title, payload?.data?.titel, payload?.data?.title]
  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (value) {
      return value
    }
  }

  return null
}

function extractScenarioVersionFromLunettesPayload(payload) {
  if (payload == null || typeof payload !== 'object') {
    return null
  }

  const candidates = [
    payload?.version,
    payload?.szenario_version,
    payload?.scenario_version,
    payload?.data?.version,
    payload?.data?.szenario_version,
    payload?.data?.scenario_version,
  ]

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) {
      return value
    }
  }

  return null
}

async function fetchScenarioMetadataFromLunettes({ scenarioId, software }) {
  const context = tryReadLunettesApiContext(software)
  if (!context) {
    return { confluencePageId: null, title: null, version: null }
  }

  const url = `${context.baseUrl}/api/anfo/szenario/${encodeURIComponent(String(scenarioId))}`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: context.authHeader,
    },
  })

  if (response.status === 404) {
    return { confluencePageId: null, title: null, version: null }
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Lunettes-Abfrage des Szenarios ${scenarioId} fehlgeschlagen (${response.status} ${response.statusText}): ${body}`)
  }

  const responseText = await response.text()
  if (!responseText.trim()) {
    return { confluencePageId: null, title: null, version: null }
  }

  let payload = null
  try {
    payload = JSON.parse(responseText)
  } catch {
    payload = responseText
  }

  return {
    confluencePageId: extractConfluencePageIdFromLunettesPayload(payload),
    title: extractScenarioTitleFromLunettesPayload(payload),
    version: extractScenarioVersionFromLunettesPayload(payload),
  }
}

async function notifyLunettesAboutConfluencePage({ scenarioId, confluencePageId, software }) {
  const context = readLunettesApiContext(software)
  const url = `${context.baseUrl}/api/anfo/szenario/${encodeURIComponent(String(scenarioId))}/confluence-page-id`

  await confluenceJsonRequest(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: context.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      confluence_page_id: String(confluencePageId),
    }),
  }, `Lunettes-Rueckmeldung fuer Confluence-Seite ${confluencePageId} fehlgeschlagen`)
}

function guessContentType(filePath) {
  const ext = extname(String(filePath || '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  return 'application/octet-stream'
}

async function uploadAttachment({ attachmentApiBaseUrl, authHeader, pageId, attachmentName, filePath }) {
  const fileBuffer = await readFile(filePath)
  const form = new FormData()
  form.append('file', new Blob([fileBuffer], { type: guessContentType(filePath) }), attachmentName)

  const url = `${attachmentApiBaseUrl}/content/${encodeURIComponent(pageId)}/child/attachment`
  await confluenceJsonRequest(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      'X-Atlassian-Token': 'nocheck',
    },
    body: form,
  }, `Anhang ${attachmentName} konnte nicht hochgeladen werden`)
}

function parseOptionalConfluencePageId(value) {
  return String(value || '').trim()
}

function parseCliArgs(argv) {
  const positionalArgs = []
  const optionArgs = []

  for (const token of argv) {
    if (token.startsWith('--')) {
      optionArgs.push(token)
    } else {
      positionalArgs.push(token)
    }
  }

  return {
    scenarioPath: positionalArgs[0] || '',
    pageIdArg: positionalArgs[1] || '',
    optionArgs,
  }
}

function parseRequiredScenarioId(argv) {
  const token = argv.find((entry) => entry.startsWith('--scenario-id='))
  const scenarioId = buildScenarioOutputFolderName({
    scenarioId: token ? token.slice('--scenario-id='.length) : '',
    fallbackName: '',
  })
  if (!scenarioId) {
    throw new Error('Scenario-ID fehlt. Erwartet: --scenario-id=<id>')
  }
  return scenarioId
}

function parseOptionalScenarioTitle(argv) {
  const token = argv.find((entry) => entry.startsWith('--scenario-title='))
  return String(token ? token.slice('--scenario-title='.length) : '').trim()
}

function parseOptionalSoftware(argv) {
  const token = argv.find((entry) => entry.startsWith('--software='))
  return String(token ? token.slice('--software='.length) : '').trim()
}

function readPublishConfig(software) {
  const workspaceRoot = process.cwd()
  const centralConfig = loadCentralConfig(workspaceRoot, { software })
  const publishConfig = centralConfig?.config?.['publish-to-confluence']

  return {
    parentPageId: String(publishConfig?.parent_page_id || '').trim(),
    sourcePathRelative: centralConfig?.sourcePathRelative || 'scenario.config.json',
  }
}

function buildConfluencePageTitle({ scenarioId, scenarioTitle, scenarioVersion }) {
  const normalizedScenarioId = String(scenarioId || '').trim() || 'unknown'
  const normalizedTitle = String(scenarioTitle || '').trim() || 'Unbenannt'
  const normalizedVersion = String(scenarioVersion || 'unknown').trim() || 'unknown'
  return `Szenario ${normalizedScenarioId} : ${normalizedTitle} (Version ${normalizedVersion})`
}

async function findLatestSuccessfulRender({ scenarioId }) {
  const folderName = buildScenarioOutputFolderName({ scenarioId, fallbackName: 'scenario' })
  const videoGeneratorDir = resolve('output', folderName, 'videogenerator')
  if (!existsSync(videoGeneratorDir)) {
    throw new Error(`Kein Videogenerator-Ordner gefunden: ${videoGeneratorDir}`)
  }

  const entries = await readdir(videoGeneratorDir, { withFileTypes: true })
  const metadataFiles = entries
    .filter((entry) => entry.isFile() && /^scenario-tts-remotion-render-.*\.json$/i.test(entry.name))
    .map((entry) => join(videoGeneratorDir, entry.name))

  if (!metadataFiles.length) {
    throw new Error(`Keine Remotion-Metadateien gefunden in ${videoGeneratorDir}`)
  }

  const candidates = []
  for (const metaPath of metadataFiles) {
    let meta = null
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8'))
    } catch {
      continue
    }

    if (meta?.planOnly === true) {
      continue
    }

    const outputVideoRaw = String(meta?.outputVideo || '').trim()
    if (!outputVideoRaw) {
      continue
    }

    const outputVideoPath = resolve(outputVideoRaw)
    if (!existsSync(outputVideoPath)) {
      continue
    }

    const [metaStats, videoStats] = await Promise.all([stat(metaPath), stat(outputVideoPath)])
    if (!videoStats.isFile() || videoStats.size <= 0) {
      continue
    }

    candidates.push({
      metaPath,
      metaStats,
      videoPath: outputVideoPath,
      videoStats,
    })
  }

  if (!candidates.length) {
    throw new Error(`Es wurde kein erfolgreich gerendertes Remotion-Video fuer "${scenarioId}" gefunden.`)
  }

  candidates.sort((left, right) => {
    const timeDiff = right.metaStats.mtimeMs - left.metaStats.mtimeMs
    if (timeDiff !== 0) return timeDiff
    return right.videoStats.mtimeMs - left.videoStats.mtimeMs
  })

  return candidates[0]
}

async function findLatestTimelineRun({ scenarioId, scenarioSourceRelative }) {
  const folderName = buildScenarioOutputFolderName({ scenarioId, fallbackName: 'scenario' })
  const runsDir = resolve('output', folderName, 'runs')
  if (!existsSync(runsDir)) {
    throw new Error(`Kein Runs-Ordner gefunden: ${runsDir}`)
  }

  const normalizedScenarioSource = normalizeWorkspaceRelativePath(scenarioSourceRelative)
  const runEntries = await readdir(runsDir, { withFileTypes: true })
  const candidates = []

  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) {
      continue
    }

    const runRoot = join(runsDir, runEntry.name)
    const runMetaPath = join(runRoot, 'run-meta.json')
    const artifactsDir = join(runRoot, 'artifacts')
    if (!existsSync(runMetaPath) || !existsSync(artifactsDir)) {
      continue
    }

    let runMeta = null
    try {
      runMeta = JSON.parse(await readFile(runMetaPath, 'utf8'))
    } catch {
      continue
    }

    const runSource = normalizeWorkspaceRelativePath(runMeta?.scenario?.sourcePathRelative || runMeta?.scenario?.sourcePathNormalized || '')
    if (runSource && runSource !== normalizedScenarioSource) {
      continue
    }

    const artifactEntries = await readdir(artifactsDir, { withFileTypes: true }).catch(() => [])
    for (const artifactEntry of artifactEntries) {
      if (!artifactEntry.isDirectory()) {
        continue
      }

      const artifactDir = join(artifactsDir, artifactEntry.name)
      const timelinePath = join(artifactDir, 'scenario-step-timeline.json')
      const rawVideoPath = join(artifactDir, 'video.webm')
      if (!existsSync(timelinePath) || !existsSync(rawVideoPath)) {
        continue
      }

      let timeline = null
      try {
        timeline = JSON.parse(await readFile(timelinePath, 'utf8'))
      } catch {
        continue
      }

      const timelineSource = normalizeWorkspaceRelativePath(timeline?.scenarioSource || '')
      if (timelineSource && timelineSource !== normalizedScenarioSource) {
        continue
      }

      const [timelineStats, rawVideoStats] = await Promise.all([stat(timelinePath), stat(rawVideoPath)])
      if (!rawVideoStats.isFile() || rawVideoStats.size <= 0) {
        continue
      }

      candidates.push({
        runRoot,
        runMetaPath,
        artifactDir,
        timelinePath,
        rawVideoPath,
        timeline,
        timelineStats,
        rawVideoStats,
      })
    }
  }

  if (!candidates.length) {
    throw new Error(`Kein Testlauf mit Timeline und Rohvideo fuer "${scenarioId}" gefunden.`)
  }

  candidates.sort((left, right) => {
    const timeDiff = right.timelineStats.mtimeMs - left.timelineStats.mtimeMs
    if (timeDiff !== 0) return timeDiff
    return right.rawVideoStats.mtimeMs - left.rawVideoStats.mtimeMs
  })

  return candidates[0]
}

async function resolveScenarioStructure({ scenarioAbsolutePath, software }) {
  const central = loadCentralConfig(process.cwd(), { software })
  const testScriptConfig = getTestScriptConfig(central?.config || {})
  const resolved = await scenarioToSpecSource({
    scenarioPath: scenarioAbsolutePath,
    xsdPath: DEFAULT_XSD_PATH,
    centralConfig: testScriptConfig,
    generatedSpecPath: resolve('/tmp', 'publish-to-confluence.generated.spec.js'),
    fragmentSource: 'lunettes',
    allowEmptyFlow: true,
  })

  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })

  const parsed = parser.parse(resolved.resolvedXmlSource)
  const rootNode = Array.isArray(parsed)
    ? parsed.find((entry) => getNodeTag(entry) === 'SzenarioScript')
    : null

  if (!rootNode) {
    throw new Error('Resolved SzenarioScript konnte nicht gelesen werden.')
  }

  return {
    resolvedRoot: rootNode,
    resolvedXmlSource: resolved.resolvedXmlSource,
  }
}

function filterTimelineSteps(timeline) {
  const steps = Array.isArray(timeline?.steps) ? timeline.steps : []
  return steps.filter((entry) => {
    const stepId = String(entry?.stepId || '').trim()
    if (!stepId || stepId.endsWith('__autoscroll')) {
      return false
    }
    if (String(entry?.status || '').trim().toLowerCase() === 'skipped') {
      return false
    }
    return true
  })
}

function buildTimelineStepLookup(timelineEntries) {
  const byStepId = new Map()

  for (const entry of Array.isArray(timelineEntries) ? timelineEntries : []) {
    const stepId = String(entry?.stepId || '').trim()
    if (!stepId) {
      continue
    }

    if (!byStepId.has(stepId)) {
      byStepId.set(stepId, entry)
    }
  }

  return byStepId
}

function createDocumentationTree() {
  return {
    items: [],
  }
}

function ensureSyntheticStep(state, fallbackTitle = 'Schritt') {
  if (state.currentStep) {
    return state.currentStep
  }

  state.syntheticStepCounter += 1
  const stepItem = {
    type: 'step',
    title: `${fallbackTitle} ${state.syntheticStepCounter}`,
    items: [],
  }
  if (state.currentChapter) {
    state.currentChapter.items.push(stepItem)
  } else {
    state.root.items.push(stepItem)
  }
  state.currentStep = stepItem
  return stepItem
}

function pushContentItem(state, item) {
  if (state.currentStep) {
    state.currentStep.items.push(item)
    return
  }
  if (state.currentChapter) {
    state.currentChapter.items.push(item)
    return
  }
  state.root.items.push(item)
}

function createTimelineReference(resolvedStepId, timelineEntry, timelineContext) {
  const normalizedResolvedStepId = String(resolvedStepId || '').trim() || null
  if (!timelineEntry) {
    return {
      type: 'timeline-step',
      stepId: normalizedResolvedStepId,
      screenshotAttachmentName: null,
    }
  }

  const screenshotRelativePath = String(timelineEntry?.screenshotPath || '').trim()
  const screenshotAbsolutePath = screenshotRelativePath
    ? resolve(dirname(timelineContext.timelinePath), screenshotRelativePath)
    : null

  const attachmentName = screenshotAbsolutePath
    ? timelineContext.screenshotAttachmentNames.get(screenshotAbsolutePath) || null
    : null

  return {
    type: 'timeline-step',
    stepId: normalizedResolvedStepId || String(timelineEntry?.stepId || '').trim() || null,
    screenshotAttachmentName: attachmentName,
  }
}

function isTimelineInteractionTag(tag) {
  return TIMELINE_INTERACTION_TAGS.has(tag)
}

function resolveTimelineEntryForNode(node, timelineContext) {
  const resolvedStepId = String(getNodeAttrs(node)?.['@_resolved-id'] || '').trim()
  if (!resolvedStepId) {
    return {
      resolvedStepId: null,
      timelineEntry: null,
    }
  }

  return {
    resolvedStepId,
    timelineEntry: timelineContext.timelineEntriesByStepId.get(resolvedStepId) || null,
  }
}

function walkScenarioNodes(nodes, state, timelineContext) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const tag = getNodeTag(node)
    if (!tag) {
      continue
    }

    if (tag === 'Kapitel') {
      const title = readTextNode(getNodeChildren(node)) || `Kapitel ${state.chapterCounter + 1}`
      const chapterItem = { type: 'chapter', title, items: [] }
      state.root.items.push(chapterItem)
      state.currentChapter = chapterItem
      state.currentStep = null
      state.chapterCounter += 1
      continue
    }

    if (tag === 'Schritt') {
      const title = readTextNode(getNodeChildren(node)) || `Schritt ${state.stepCounter + 1}`
      const stepItem = { type: 'step', title, items: [] }
      if (state.currentChapter) {
        state.currentChapter.items.push(stepItem)
      } else {
        state.root.items.push(stepItem)
      }
      state.currentStep = stepItem
      state.stepCounter += 1
      continue
    }

    if (tag === 'Info') {
      pushContentItem(state, {
        type: 'info',
        text: readTextNode(getNodeChildren(node)),
        infoType: String(getNodeAttrs(node)?.['@_typ'] || 'Info').trim() || 'Info',
      })
      continue
    }

    if (tag === 'Folie') {
      const text = readTextNode(getNodeChildren(node))
      if (text) {
        pushContentItem(state, {
          type: 'info',
          text,
          infoType: 'Folie',
        })
      }
      continue
    }

    if (CONTAINER_TAGS.has(tag)) {
      walkScenarioNodes(getNodeChildren(node), state, timelineContext)
      continue
    }

    if (isTimelineInteractionTag(tag)) {
      const targetStep = ensureSyntheticStep(state, 'Schritt')
      const { resolvedStepId, timelineEntry } = resolveTimelineEntryForNode(node, timelineContext)
      targetStep.items.push(createTimelineReference(resolvedStepId, timelineEntry, timelineContext))
      continue
    }
  }
}

function buildDocumentationFromScenario({ resolvedRootNode, timelineContext }) {
  const state = {
    root: createDocumentationTree(),
    currentChapter: null,
    currentStep: null,
    chapterCounter: 0,
    stepCounter: 0,
    syntheticStepCounter: 0,
  }

  walkScenarioNodes(getNodeChildren(resolvedRootNode), state, timelineContext)
  return state.root
}

function collectScreenshotUploadPlan({ timeline, timelinePath, scenarioId }) {
  const screenshotAttachmentNames = new Map()
  const uploads = []
  const seen = new Set()

  for (const entry of Array.isArray(timeline?.steps) ? timeline.steps : []) {
    const relativePath = String(entry?.screenshotPath || '').trim()
    if (!relativePath) {
      continue
    }

    const absolutePath = resolve(dirname(timelinePath), relativePath)
    if (!existsSync(absolutePath)) {
      continue
    }

    if (seen.has(absolutePath)) {
      continue
    }
    seen.add(absolutePath)

    const attachmentName = `${String(scenarioId)}-${basename(absolutePath)}`
    screenshotAttachmentNames.set(absolutePath, attachmentName)
    uploads.push({
      filePath: absolutePath,
      attachmentName,
    })
  }

  return {
    screenshotAttachmentNames,
    uploads,
  }
}

function renderVideoEmbed(attachmentName, { height = 480 } = {}) {
  if (!attachmentName) {
    return '<p><em>Kein Video verfuegbar.</em></p>'
  }

  return `<ac:structured-macro ac:name="view-file" ac:schema-version="1">
  <ac:parameter ac:name="name"><ri:attachment ri:filename="${escapeXml(attachmentName)}" /></ac:parameter>
  <ac:parameter ac:name="height">${Math.max(120, Math.floor(Number(height) || 480))}</ac:parameter>
</ac:structured-macro>`
}

function renderFileEmbed(attachmentName) {
  if (!attachmentName) {
    return '<p><em>Kein Anhang verfuegbar.</em></p>'
  }

  return `<ac:structured-macro ac:name="view-file" ac:schema-version="1">
  <ac:parameter ac:name="name"><ri:attachment ri:filename="${escapeXml(attachmentName)}" /></ac:parameter>
</ac:structured-macro>`
}

function renderTipMacro(text, title = '') {
  const safeTitle = String(title || '').trim()
  const titleBlock = safeTitle
    ? `<ac:parameter ac:name="title">${escapeXml(safeTitle)}</ac:parameter>
`
    : ''

  return `<ac:structured-macro ac:name="tip" ac:schema-version="1" ac:local-id="${escapeXml(randomUUID())}" ac:macro-id="${escapeXml(randomUUID())}">
${titleBlock}<ac:rich-text-body>
<p>${escapeXml(text)}</p>
</ac:rich-text-body></ac:structured-macro>`
}

function renderScreenshotItem(item) {
  if (!item.screenshotAttachmentName) {
    return ''
  }

  const heading = item.stepId
    ? `<p><code>${escapeXml(item.stepId)}</code></p>`
    : ''

  return `${heading}<ac:image ac:layout="center" ac:custom-width="true" ac:width="960">
  <ri:attachment ri:filename="${escapeXml(item.screenshotAttachmentName)}" />
</ac:image>`
}

function renderDocumentationItems(items = []) {
  const parts = []

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue
    }

    if (item.type === 'info') {
      const macroTitle = item.infoType && item.infoType !== 'Info' ? item.infoType : ''
      parts.push(renderTipMacro(item.text, macroTitle))
      continue
    }

    if (item.type === 'timeline-step') {
      parts.push(renderScreenshotItem(item))
      continue
    }

    if (item.type === 'step') {
      const renderedChildren = renderDocumentationItems(item.items)
      if (renderedChildren) {
        parts.push(`<h3>${escapeXml(item.title)}</h3>`)
        parts.push(renderedChildren)
      }
      continue
    }

    if (item.type === 'chapter') {
      const renderedChildren = renderDocumentationItems(item.items)
      if (renderedChildren) {
        parts.push(`<h2>${escapeXml(item.title)}</h2>`)
        parts.push(renderedChildren)
      }
    }
  }

  return parts.filter(Boolean).join('\n')
}

function buildManagedStorageBlock({
  trainingVideoAttachmentName,
  rawVideoAttachmentName,
  timelineArchiveAttachmentName,
  documentationTree,
}) {
  const documentationBody = renderDocumentationItems(documentationTree.items)

  return `${MANAGED_BLOCK_START}
<ac:structured-macro ac:name="toc" ac:schema-version="1" />
<h1>Schulungsvideo</h1>
${renderVideoEmbed(trainingVideoAttachmentName, { height: 540 })}
<h1>Anleitung</h1>
${documentationBody || '<p><em>Keine Anleitung ableitbar.</em></p>'}
<h1>Anhang</h1>
<h2>Rohvideo</h2>
${renderVideoEmbed(rawVideoAttachmentName, { height: 420 })}
<h2>Screenshots + Timeline</h2>
${renderFileEmbed(timelineArchiveAttachmentName)}
${MANAGED_BLOCK_END}`
}

async function buildTimelineArchive({ timelinePath, scenarioId }) {
  const timelineDir = dirname(timelinePath)
  const archivePath = resolve('/tmp', `${String(scenarioId)}-timeline-screenshots.zip`)
  const timelineFilename = basename(timelinePath)
  const screenshotsDirName = 'timeline-screenshots'
  const args = ['-rq', archivePath, timelineFilename]

  if (existsSync(join(timelineDir, screenshotsDirName))) {
    args.push(screenshotsDirName)
  }

  try {
    await execFileAsync('zip', args, { cwd: timelineDir })
  } catch (error) {
    const stderr = String(error?.stderr || '').trim()
    throw new Error(`ZIP fuer Timeline/Screenshots konnte nicht erstellt werden: ${stderr || error.message}`)
  }

  return archivePath
}

function mergeManagedBlock(_existingBody, managedBlock) {
  return managedBlock
}

async function updatePageBody({ pageApiBaseUrl, authHeader, pageId, title, currentVersion, bodyStorage }) {
  const url = `${pageApiBaseUrl}/pages/${encodeURIComponent(pageId)}`
  await confluenceJsonRequest(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: String(pageId),
      status: 'current',
      title,
      body: {
        representation: 'storage',
        value: bodyStorage,
      },
      version: {
        number: currentVersion + 1,
        message: 'Lumiere Publish Helper: Videos und Anleitung aktualisiert',
      },
    }),
  }, `Confluence-Seite ${pageId} konnte nicht aktualisiert werden`)
}

async function main() {
  const argv = process.argv.slice(2)
  const showHelp = argv.includes('--help') || argv.includes('-h')
  const cliArgs = parseCliArgs(argv)
  const scenarioPath = cliArgs.scenarioPath
  if (showHelp || !scenarioPath) {
    printUsage()
    process.exit(showHelp ? 0 : 1)
  }

  const scenarioAbsolutePath = resolve(scenarioPath)
  if (!existsSync(scenarioAbsolutePath)) {
    fail(`Szenarioscript nicht gefunden: ${scenarioPath}`)
  }
  if (extname(scenarioAbsolutePath).toLowerCase() !== '.xml') {
    fail(`Es wird ein XML-Szenarioscript erwartet: ${scenarioPath}`)
  }

  try {
    const credentials = parseCredentialsFromEnv()
    const apiContext = buildApiContext(credentials)
    const pageIdFromCli = parseOptionalConfluencePageId(cliArgs.pageIdArg)
    const scenarioId = parseRequiredScenarioId(cliArgs.optionArgs)
    const scenarioTitleOverride = parseOptionalScenarioTitle(cliArgs.optionArgs)
    const software = parseOptionalSoftware(cliArgs.optionArgs)
    const publishConfig = readPublishConfig(software)
    const scenarioXmlRaw = await readFile(scenarioAbsolutePath, 'utf8')
    const scenarioMeta = parseScenarioMetaFromRawXml(scenarioXmlRaw)
    const lunettesScenario = await fetchScenarioMetadataFromLunettes({ scenarioId, software })
    const nextTitle = buildConfluencePageTitle({
      scenarioId,
      scenarioTitle: scenarioTitleOverride || lunettesScenario.title || scenarioMeta.title || scenarioId,
      scenarioVersion: lunettesScenario.version || scenarioMeta.version,
    })
    const scenarioSourceRelative = normalizeWorkspaceRelativePath(relative(process.cwd(), scenarioAbsolutePath))

    const latestRender = await findLatestSuccessfulRender({ scenarioId }).catch(() => null)
    const latestTimelineRun = await findLatestTimelineRun({
      scenarioId,
      scenarioSourceRelative,
    })
    const screenshotPlan = collectScreenshotUploadPlan({
      timeline: latestTimelineRun.timeline,
      timelinePath: latestTimelineRun.timelinePath,
      scenarioId,
    })
    const timelineArchivePath = await buildTimelineArchive({
      timelinePath: latestTimelineRun.timelinePath,
      scenarioId,
    })
    const resolvedStructure = await resolveScenarioStructure({
      scenarioAbsolutePath,
      software,
    })
    const filteredTimelineEntries = filterTimelineSteps(latestTimelineRun.timeline)
    const timelineEntriesByStepId = buildTimelineStepLookup(filteredTimelineEntries)
    const timelineContext = {
      timelineEntriesByStepId,
      timelinePath: latestTimelineRun.timelinePath,
      screenshotAttachmentNames: screenshotPlan.screenshotAttachmentNames,
    }
    const documentationTree = buildDocumentationFromScenario({
      resolvedRootNode: resolvedStructure.resolvedRoot,
      timelineContext,
    })

    let pageId = pageIdFromCli || lunettesScenario.confluencePageId
    let createdPageId = null

    const initialManagedBlock = buildManagedStorageBlock({
      trainingVideoAttachmentName: null,
      rawVideoAttachmentName: null,
      timelineArchiveAttachmentName: null,
      documentationTree,
    })

    if (!pageId) {
      const parentPageId = publishConfig.parentPageId
      if (!parentPageId) {
        throw new Error(`Confluence-Page-ID fehlt. Setze entweder den zweiten CLI-Parameter oder ${publishConfig.sourcePathRelative} > scenario["publish-to-confluence"].parent_page_id.`)
      }

      const parentPage = await fetchPage({
        pageApiBaseUrl: apiContext.pageApiBaseUrl,
        authHeader: apiContext.authHeader,
        pageId: parentPageId,
      })
      if (!parentPage.spaceId) {
        throw new Error(`Parent-Confluence-Seite ${parentPageId} lieferte keine spaceId.`)
      }

      const createdPage = await createPage({
        pageApiBaseUrl: apiContext.pageApiBaseUrl,
        authHeader: apiContext.authHeader,
        title: nextTitle,
        parentPageId,
        spaceId: parentPage.spaceId,
        bodyStorage: initialManagedBlock,
      })
      pageId = createdPage.pageId
      createdPageId = createdPage.pageId
    }

    const page = await fetchPage({
      pageApiBaseUrl: apiContext.pageApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
    })
    await assertPageHasNoComments({
      attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
    })

    const trainingVideoAttachmentName = latestRender?.videoPath
      ? basename(latestRender.videoPath)
      : null
    const rawVideoAttachmentName = `${String(scenarioId)}-${basename(latestTimelineRun.rawVideoPath)}`
    const timelineArchiveAttachmentName = `${String(scenarioId)}-${basename(timelineArchivePath)}`

    if (latestRender?.videoPath && trainingVideoAttachmentName) {
      await uploadAttachment({
        attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
        authHeader: apiContext.authHeader,
        pageId,
        attachmentName: trainingVideoAttachmentName,
        filePath: latestRender.videoPath,
      })
    }
    await uploadAttachment({
      attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
      attachmentName: rawVideoAttachmentName,
      filePath: latestTimelineRun.rawVideoPath,
    })
    await uploadAttachment({
      attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
      attachmentName: timelineArchiveAttachmentName,
      filePath: timelineArchivePath,
    })

    for (const screenshotUpload of screenshotPlan.uploads) {
      await uploadAttachment({
        attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
        authHeader: apiContext.authHeader,
        pageId,
        attachmentName: screenshotUpload.attachmentName,
        filePath: screenshotUpload.filePath,
      })
    }

    const managedBlock = buildManagedStorageBlock({
      trainingVideoAttachmentName,
      rawVideoAttachmentName,
      timelineArchiveAttachmentName,
      documentationTree,
    })
    const nextBody = mergeManagedBlock(page.bodyStorage, managedBlock)

    await updatePageBody({
      pageApiBaseUrl: apiContext.pageApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
      title: nextTitle,
      currentVersion: page.versionNumber,
      bodyStorage: nextBody,
    })

    if (createdPageId) {
      await notifyLunettesAboutConfluencePage({
        scenarioId,
        confluencePageId: createdPageId,
        software,
      })
    }

    console.log(`Confluence-Seite aktualisiert: ${pageId}`)
    console.log(`Titel: ${nextTitle}`)
    console.log(`Auth-Modus: ${apiContext.authModeLabel}`)
    if (latestRender?.videoPath) {
      console.log(`Schulungsvideo: ${latestRender.videoPath}`)
    } else {
      console.log('Schulungsvideo: keines verfuegbar')
    }
    console.log(`Rohvideo: ${latestTimelineRun.rawVideoPath}`)
    console.log(`Timeline: ${latestTimelineRun.timelinePath}`)
    console.log(`ZIP: ${timelineArchivePath}`)
    console.log(`Screenshots: ${screenshotPlan.uploads.length}`)
    if (createdPageId) {
      console.log(`Neu angelegte Seite unter Parent: ${publishConfig.parentPageId}`)
      console.log(`Lunettes-Rueckmeldung: ${createdPageId}`)
    }
  } catch (error) {
    fail(String(error?.message || error))
  }
}

await main()
