#!/usr/bin/env node

import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, extname, join, resolve } from 'path'
import { Buffer } from 'buffer'
import { XMLParser } from 'fast-xml-parser'
import { buildScenarioOutputFolderName } from '../scripts/shared/scenario-output.mjs'

const CREDENTIALS_ENV_NAME = 'CONFLUENCE_PUBLISHHELPER_CREDENTIALS'
const MANAGED_BLOCK_START = '<!-- lumiere-publishhelper:start -->'
const MANAGED_BLOCK_END = '<!-- lumiere-publishhelper:end -->'

function printUsage() {
  console.log(`Verwendung:
  node publishhelper/publish-scenario-to-confluence.mjs <szenarioscript.xml> <confluence-page-id> --scenario-id=<id>

Voraussetzungen:
  - Es existiert ein erfolgreich gerendertes Remotion-Video im output/.../videogenerator Ordner
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

function buildAuthorizationHeader({ email, apiToken }) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
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

  return response.json()
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

  if (!title || !Number.isFinite(versionNumber)) {
    throw new Error(`Confluence-Seite ${pageId} lieferte keine gueltigen Titel-/Versionsdaten.`)
  }

  return {
    title,
    versionNumber,
    bodyStorage,
  }
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

function buildManagedStorageBlock({ attachmentName, scenarioScriptRaw }) {
  return `${MANAGED_BLOCK_START}
<h1>Video</h1>
<ac:image ac:align="center" ac:layout="center" ac:custom-width="true" ac:width="760" ac:alt="${escapeXml(attachmentName)}">
  <ri:attachment ri:filename="${escapeXml(attachmentName)}" />
</ac:image>
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

function parseConfluencePageId(value) {
  const pageId = String(value || '').trim()
  if (!pageId) {
    throw new Error('Confluence-Page-ID fehlt. Erwartet als zweiter CLI-Parameter.')
  }
  return pageId
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

function buildConfluencePageTitle({ scenarioTitle, scenarioId }) {
  return `[Szenario] ${String(scenarioTitle || scenarioId || '').trim()}`
}

async function main() {
  const argv = process.argv.slice(2)
  const scenarioPath = argv[0]
  const pageIdArg = argv[1]
  if (!scenarioPath || scenarioPath === '--help' || scenarioPath === '-h') {
    printUsage()
    process.exit(scenarioPath ? 0 : 1)
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
    const pageId = parseConfluencePageId(pageIdArg)
    const scenarioId = parseRequiredScenarioId(argv)
    const scenarioTitleOverride = parseOptionalScenarioTitle(argv)
    const scenarioScriptRaw = await readFile(scenarioAbsolutePath, 'utf8')
    const scenario = parseScenarioScript(scenarioScriptRaw)

    const latestRender = await findLatestSuccessfulRender({ scenarioId })
    const page = await fetchPage({
      pageApiBaseUrl: apiContext.pageApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
    })

    const attachmentName = `${basename(scenarioAbsolutePath, extname(scenarioAbsolutePath))}-remotion${extname(latestRender.videoPath) || '.mp4'}`
    await uploadAttachment({
      attachmentApiBaseUrl: apiContext.attachmentApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
      attachmentName,
      videoPath: latestRender.videoPath,
    })

    const managedBlock = buildManagedStorageBlock({
      attachmentName,
      scenarioScriptRaw,
    })
    const nextBody = mergeManagedBlock(page.bodyStorage, managedBlock)
    const nextTitle = buildConfluencePageTitle({
      scenarioTitle: scenarioTitleOverride || scenario.title,
      scenarioId,
    })

    await updatePageBody({
      pageApiBaseUrl: apiContext.pageApiBaseUrl,
      authHeader: apiContext.authHeader,
      pageId,
      title: nextTitle,
      currentVersion: page.versionNumber,
      bodyStorage: nextBody,
    })

    console.log(`Confluence-Seite aktualisiert: ${pageId}`)
    console.log(`Titel: ${nextTitle}`)
    console.log(`Auth-Modus: ${apiContext.authModeLabel}`)
    console.log(`Video: ${latestRender.videoPath}`)
    console.log(`Anhang: ${attachmentName}`)
  } catch (error) {
    fail(String(error?.message || error))
  }
}

await main()
