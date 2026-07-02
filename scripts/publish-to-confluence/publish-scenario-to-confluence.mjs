#!/usr/bin/env node

import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, extname, join, resolve } from 'path'
import { Buffer } from 'buffer'
import { XMLParser } from 'fast-xml-parser'
import { buildScenarioOutputFolderName } from '../shared/scenario-output.mjs'
import { loadCentralConfig } from '../shared/central-config.mjs'

const CREDENTIALS_ENV_NAME = 'CONFLUENCE_PUBLISHHELPER_CREDENTIALS'
const MANAGED_BLOCK_START = '<!-- lumiere-publishhelper:start -->'
const MANAGED_BLOCK_END = '<!-- lumiere-publishhelper:end -->'

function printUsage() {
  console.log(`Verwendung:
  node scripts/publish-to-confluence/publish-scenario-to-confluence.mjs <szenarioscript.xml> [confluence-page-id] --scenario-id=<id>

Voraussetzungen:
  - Optional: Es existiert ein erfolgreich gerendertes Remotion-Video im output/.../videogenerator Ordner
  - ${CREDENTIALS_ENV_NAME} ist gesetzt
`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseScenarioScript(xmlRaw) {
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

  return {
    title,
  }
}

function parseCredentialsFromEnv() {
  const raw = process.env[CREDENTIALS_ENV_NAME]
  if (!raw || !raw.trim()) {
    throw new Error(`Die Umgebungsvariable ${CREDENTIALS_ENV_NAME} fehlt.`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${CREDENTIALS_ENV_NAME} muss gueltiges JSON sein.`)
  }

  const baseUrl = String(parsed?.baseUrl || parsed?.siteUrl || '').trim().replace(/\/+$/, '')
  const email = String(parsed?.email || '').trim()
  const apiToken = String(parsed?.apiToken || '').trim()
  const cloudId = String(parsed?.cloudId || '').trim()
  const accessToken = String(parsed?.accessToken || '').trim()

  if (cloudId && accessToken) {
    if (!baseUrl) {
      throw new Error(`${CREDENTIALS_ENV_NAME} braucht im Modus "cloudId"/"accessToken" zusaetzlich "baseUrl" oder "siteUrl", damit das Video eingebettet werden kann.`)
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
    `${CREDENTIALS_ENV_NAME} muss entweder "cloudId" und "accessToken" oder "baseUrl", "email" und "apiToken" enthalten.`
  )
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
    const raw = await readFile(metaPath, 'utf8')
    let meta
    try {
      meta = JSON.parse(raw)
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

async function findLatestTestRawVideo({ scenarioId }) {
  const folderName = buildScenarioOutputFolderName({ scenarioId, fallbackName: 'scenario' })
  const runsDir = resolve('output', folderName, 'runs')
  if (!existsSync(runsDir)) {
    return null
  }

  const entries = await readdir(runsDir, { withFileTypes: true })
  const candidates = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const runMetaPath = join(runsDir, entry.name, 'run-meta.json')
    if (!existsSync(runMetaPath)) {
      continue
    }

    let meta = null
    try {
      meta = JSON.parse(await readFile(runMetaPath, 'utf8'))
    } catch {
      continue
    }

    const artifactsRelative = String(meta?.exportedTo?.artifactsRelative || '').trim()
    if (!artifactsRelative) {
      continue
    }

    const artifactsDir = resolve(artifactsRelative)
    if (!existsSync(artifactsDir)) {
      continue
    }

    const artifactEntries = await readdir(artifactsDir, { withFileTypes: true }).catch(() => [])
    for (const artifactEntry of artifactEntries) {
      if (!artifactEntry.isDirectory()) {
        continue
      }
      const rawVideoPath = join(artifactsDir, artifactEntry.name, 'video.webm')
      if (!existsSync(rawVideoPath)) {
        continue
      }

      const [metaStats, videoStats] = await Promise.all([stat(runMetaPath), stat(rawVideoPath)])
      if (!videoStats.isFile() || videoStats.size <= 0) {
        continue
      }

      candidates.push({
        runMetaPath,
        metaStats,
        videoPath: rawVideoPath,
        videoStats,
      })
    }
  }

  if (!candidates.length) {
    return null
  }

  candidates.sort((left, right) => {
    const timeDiff = right.metaStats.mtimeMs - left.metaStats.mtimeMs
    if (timeDiff !== 0) return timeDiff
    return right.videoStats.mtimeMs - left.videoStats.mtimeMs
  })

  return candidates[0]
}

function buildAuthorizationHeader({ email, apiToken }) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
}

function buildBasicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function buildApiContext(credentials) {
  if (credentials.mode === 'cloud') {
    return {
    pageApiBaseUrl: `https://api.atlassian.com/ex/confluence/${encodeURIComponent(credentials.cloudId)}/wiki/api/v2`,
    attachmentApiBaseUrl: `https://api.atlassian.com/ex/confluence/${encodeURIComponent(credentials.cloudId)}/wiki/rest/api`,
    authHeader: `Bearer ${credentials.accessToken}`,
    authModeLabel: 'cloud',
    siteBaseUrl: credentials.baseUrl,
  }
  }

  return {
    pageApiBaseUrl: `${credentials.baseUrl}/wiki/api/v2`,
    attachmentApiBaseUrl: `${credentials.baseUrl}/wiki/rest/api`,
    authHeader: buildAuthorizationHeader(credentials),
    authModeLabel: 'basic',
    siteBaseUrl: credentials.baseUrl,
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

  const commentCount = extractCommentCount(payload)
  if (commentCount > 0) {
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

  return {
    pageId,
  }
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
    throw new Error('Lunettes API base_url fehlt. Erwartet fuer die Rueckmeldung: scenario.config.json > scenario["lunettes-job-watcher"].base_url oder scenario["test-script"].lunettes_api.base_url')
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

  const candidates = [
    payload?.titel,
    payload?.title,
    payload?.data?.titel,
    payload?.data?.title,
  ]

  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (value) {
      return value
    }
  }

  return null
}

async function fetchScenarioMetadataFromLunettes({ scenarioId, software }) {
  const context = tryReadLunettesApiContext(software)
  if (!context) {
    return {
      confluencePageId: null,
      title: null,
    }
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
    return {
      confluencePageId: null,
      title: null,
    }
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Lunettes-Abfrage des Szenarios ${scenarioId} fehlgeschlagen (${response.status} ${response.statusText}): ${body}`)
  }

  const responseText = await response.text()
  if (!responseText.trim()) {
    return {
      confluencePageId: null,
      title: null,
    }
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

async function uploadAttachment({ attachmentApiBaseUrl, authHeader, pageId, attachmentName, videoPath }) {
  const videoBuffer = await readFile(videoPath)
  const form = new FormData()
  form.append('file', new Blob([videoBuffer], { type: 'video/mp4' }), attachmentName)

  const url = `${attachmentApiBaseUrl}/content/${encodeURIComponent(pageId)}/child/attachment`
  await confluenceJsonRequest(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      'X-Atlassian-Token': 'nocheck',
    },
    body: form,
  }, `Video-Anhang ${attachmentName} konnte nicht hochgeladen werden`)
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

function buildManagedStorageBlock({ attachmentName = null, rawAttachmentName = null, scenarioScriptRaw }) {
  const videoBlock = attachmentName
    ? `<h1>Video</h1>
<ac:image ac:align="center" ac:layout="center" ac:custom-width="true" ac:width="760" ac:alt="${escapeXml(attachmentName)}">
  <ri:attachment ri:filename="${escapeXml(attachmentName)}" />
</ac:image>`
    : '<p><em>Kein veroeffentlichtes Video verfuegbar.</em></p>'

  const rawVideoBlock = rawAttachmentName
    ? `<h1>Test-Rohvideo</h1>
<p><ac:link><ri:attachment ri:filename="${escapeXml(rawAttachmentName)}" /></ac:link></p>`
    : ''

  return `${MANAGED_BLOCK_START}
${videoBlock}
${rawVideoBlock}
<h1>Szenarioscript</h1>
<p>${escapeXml(scenarioScriptRaw).replace(/\r?\n/g, '<br />')}</p>
${MANAGED_BLOCK_END}`
}

function mergeManagedBlock(existingBody, managedBlock) {
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
        message: 'Lumiere Publish Helper: Video und Szenarioscript aktualisiert',
      },
    }),
  }, `Confluence-Seite ${pageId} konnte nicht aktualisiert werden`)
}

function parseOptionalConfluencePageId(value) {
  const pageId = String(value || '').trim()
  return pageId
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

function buildConfluencePageTitle({ scenarioTitle, scenarioId }) {
  return `[Szenario] ${String(scenarioTitle || scenarioId || '').trim()}`
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
    const scenarioScriptRaw = await readFile(scenarioAbsolutePath, 'utf8')
    const scenario = parseScenarioScript(scenarioScriptRaw)
    const publishConfig = readPublishConfig(software)
    const lunettesScenario = await fetchScenarioMetadataFromLunettes({ scenarioId, software })
    const nextTitle = buildConfluencePageTitle({
      scenarioTitle: scenarioTitleOverride || lunettesScenario.title || scenario.title,
      scenarioId,
    })
    let pageId = pageIdFromCli
    let createdPageId = null

    if (!pageId) {
      pageId = lunettesScenario.confluencePageId
    }

    const latestRender = await findLatestSuccessfulRender({ scenarioId }).catch(() => null)
    const latestRawVideo = await findLatestTestRawVideo({ scenarioId }).catch(() => null)
    const initialManagedBlock = buildManagedStorageBlock({
      attachmentName: null,
      rawAttachmentName: null,
      scenarioScriptRaw,
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
        throw new Error(`Parent-Confluence-Seite ${parentPageId} lieferte keine spaceId. Eine Unterseite kann nicht angelegt werden.`)
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

    let attachmentName = null
    if (latestRender?.videoPath) {
      attachmentName = basename(latestRender.videoPath)
      await uploadAttachment({
        attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
        authHeader: apiContext.authHeader,
        pageId,
        attachmentName,
        videoPath: latestRender.videoPath,
      })
    }

    let rawAttachmentName = null
    if (latestRawVideo?.videoPath) {
      rawAttachmentName = basename(latestRawVideo.videoPath)
      await uploadAttachment({
        attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
        authHeader: apiContext.authHeader,
        pageId,
        attachmentName: rawAttachmentName,
        videoPath: latestRawVideo.videoPath,
      })
    }

    const managedBlock = buildManagedStorageBlock({
      attachmentName,
      rawAttachmentName,
      scenarioScriptRaw,
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
    if (createdPageId) {
      console.log(`Neu angelegte Seite unter Parent: ${publishConfig.parentPageId}`)
      console.log(`Lunettes-Rueckmeldung: ${createdPageId}`)
    }
    if (latestRender?.videoPath && attachmentName) {
      console.log(`Video: ${latestRender.videoPath}`)
      console.log(`Anhang: ${attachmentName}`)
    } else {
      console.log('Video: keines verfuegbar, nur Szenarioscript veroeffentlicht')
    }
    if (latestRawVideo?.videoPath && rawAttachmentName) {
      console.log(`Test-Rohvideo: ${latestRawVideo.videoPath}`)
      console.log(`Rohvideo-Anhang: ${rawAttachmentName}`)
    }
  } catch (error) {
    fail(String(error?.message || error))
  }
}

await main()
