import { access, writeFile } from 'fs/promises'
import { Buffer } from 'buffer'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { centralFillStrategies } from "./central-fill-strategies.mjs"
import { extractCodeFromPdf } from "./extract-pdf-code.mjs"
export { createScenarioExecutionRuntime, createScenarioTimelineRuntime } from "./generated-scenario-runtime.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')

let envFillStrategiesImportPath = null
let fillStrategiesCache
let defaultScrollStepPx = 20

export function configureScenarioHelpers({
  envFillStrategiesImportPath: nextImportPath = null,
  scrollStepPx = 20,
} = {}) {
  envFillStrategiesImportPath = nextImportPath == null ? null : String(nextImportPath)
  defaultScrollStepPx = Math.max(1, Number(scrollStepPx ?? 20) || 20)
  fillStrategiesCache = null
}

export async function searchAndSelect(page, { target, value, resultSelector, resultIndex = 0, smoothScroll = false, stepDelayMs = 35, skipAutoScroll = false }) {
  const smoothScrollEnabled = smoothScroll === true
  const smoothStepDelayMs = Math.max(0, Number(stepDelayMs ?? 35) || 35)
  const stepPx = Math.max(1, Number(defaultScrollStepPx ?? 20) || 20)

  const ensureVisible = async (locator) => {
    if (skipAutoScroll) {
      await locator.waitFor({ state: 'attached' });
      return;
    }

    if (!smoothScrollEnabled) {
      await locator.scrollIntoViewIfNeeded();
      return;
    }

    await locator.waitFor({ state: 'attached' });
    await locator.evaluate(async (element, cfg) => {
      function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
      function getScrollableAncestor(start) {
        let current = start?.parentElement || null;
        while (current) {
          const style = window.getComputedStyle(current);
          const overflowY = style.overflowY || style.overflow || '';
          const isScrollable = /(auto|scroll|overlay)/.test(overflowY);
          if (isScrollable && current.scrollHeight > current.clientHeight) {
            return current;
          }
          current = current.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      }

      const container = getScrollableAncestor(element);
      // woher kommen die max steps?
      const maxSteps = Math.max(800, Number(cfg.maxSteps || 800));
      // Die Schrittgröße (stepPx) zusammen mit der Schrittververzögerung (smoothStepDelayMs) bestimmt die Geschwindigkeit des Scrollens. 
      //todo: ggf. braucht es hier eine gemeinsame bessere Größe. z.B. Pixel pro Sekunde oder Bildschirmanteil pro Sekunde
      const epsilon = 2;

      for (let i = 0; i < maxSteps; i += 1) {
        const elementRect = element.getBoundingClientRect();
        const containerRect = container === document.scrollingElement || container === document.documentElement
          ? { top: 0, height: window.innerHeight }
          : container.getBoundingClientRect();
        const elementCenter = elementRect.top + (elementRect.height / 2);
        const viewportCenter = containerRect.top + (containerRect.height / 2);
        const delta = elementCenter - viewportCenter;
        if (Math.abs(delta) <= epsilon) {
          return;
        }
        const step = Math.sign(delta) * Math.min(Math.abs(delta), cfg.stepPx);
        if (container === document.scrollingElement || container === document.documentElement) {
          window.scrollBy(0, step);
        } else {
          container.scrollBy(0, step);
        }
        if (cfg.stepDelayMs > 0) {
          await delay(cfg.stepDelayMs);
        }
      }
    }, { stepDelayMs: smoothStepDelayMs, maxSteps: 220, stepPx });
    await locator.scrollIntoViewIfNeeded();
  }

  const locator = page.locator(`[data-id="${target['data-id']}"]`).first();
  await ensureVisible(locator);
  await locator.fill(value);
  await locator.press('Enter');

  // Dropdown/result lists can re-render while opening; always resolve a fresh
  // locator and retry a few times to avoid detached-element races.
  await page.waitForSelector(resultSelector, { state: 'visible', timeout: 5000 });

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await pickIndexedLocator(page.locator(resultSelector), resultIndex);
    try {
      await result.waitFor({ state: 'visible', timeout: 2000 });
      await ensureVisible(result);
      await result.click();
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(120);
    }
  }

  throw lastError || new Error(`search-and-select failed for selector: ${resultSelector}`);
}

async function loadEnvFillStrategies() {
  if (fillStrategiesCache) {
    return fillStrategiesCache
  }

  const strategies = []

  // Load app-specific strategies first (higher priority)
  if (envFillStrategiesImportPath) {
    try {
      const module = await import(envFillStrategiesImportPath)
      const exported = module?.fillStrategies ?? module?.default ?? []
      if (Array.isArray(exported)) {
        strategies.push(...exported)
      }
    } catch (error) {
      console.warn(`Could not load app-specific fill strategies from ${envFillStrategiesImportPath}: ${error.message}`)
    }
  }

  // Load central strategies as fallback
  if (Array.isArray(centralFillStrategies)) {
    strategies.push(...centralFillStrategies)
  }

  fillStrategiesCache = strategies
  return fillStrategiesCache
}

async function resolveUploadAssetPath(rawPath) {
  const requestedPath = String(rawPath ?? '').trim()
  if (!requestedPath) {
    throw new Error('Upload requires a non-empty file path.')
  }

  const candidatePaths = isAbsolute(requestedPath)
    ? [requestedPath]
    : [
        resolve(process.cwd(), 'neo', 'assets', requestedPath),
        resolve(REPO_ROOT, 'neo', 'assets', requestedPath),
        resolve(process.cwd(), requestedPath),
        resolve(REPO_ROOT, requestedPath),
      ]

  for (const candidatePath of candidatePaths) {
    try {
      await access(candidatePath)
      return candidatePath
    } catch {
      // try next candidate
    }
  }

  throw new Error(`Upload-Datei nicht gefunden: ${requestedPath}. Erwartet unter neo/assets oder als absoluter/relativer Pfad.`)
}

async function resolveUploadInput(upload) {
  if (upload && typeof upload === 'object' && upload.temp === true) {
    const filename = String(upload.filename ?? '').trim()
    if (!filename) {
      throw new Error('Temporärer Upload requires a non-empty filename.')
    }

    return {
      name: filename,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(String(upload.content ?? ''), 'utf8'),
    }
  }

  return resolveUploadAssetPath(upload)
}

async function resolveUploadLocator(page, locator) {
  const rootLocator = locator.first()
  await rootLocator.waitFor({ state: 'attached' })

  const isFileInput = await rootLocator.evaluate((el) => {
    const tagName = String(el?.tagName || '').toLowerCase()
    const inputType = String(el?.getAttribute?.('type') || '').toLowerCase()
    return tagName === 'input' && inputType === 'file'
  }).catch(() => false)

  if (isFileInput) {
    return rootLocator
  }

  const fileInputLocator = rootLocator.locator('input[type="file"]').first()
  await fileInputLocator.waitFor({ state: 'attached' })
  return fileInputLocator
}

export function resolveRuntimeTemplateString(value, runtimeVariables) {
  if (typeof value !== "string") {
    return value
  }

  const missingExpressions = new Set()

  const rendered = value.replace(/{{\s*([^}]+)\s*}}/g, (_, pathExpr) => {
    const expr = String(pathExpr || "").trim()
    if (!expr) {
      return ""
    }

    const resolvedValue = expr.split(".").reduce((acc, key) => {
      if (acc && Object.prototype.hasOwnProperty.call(acc, key)) {
        return acc[key]
      }
      return undefined
    }, runtimeVariables)

    if (resolvedValue == null) {
      missingExpressions.add(expr)
      return `{{${expr}}}`
    }

    return String(resolvedValue)
  })

  if (missingExpressions.size > 0) {
    const missingList = [...missingExpressions].join(", ")
    const availableTopLevel = Object.keys(runtimeVariables || {})
    const availableText = availableTopLevel.length > 0 ? availableTopLevel.join(", ") : "<none>"
    throw new Error(
      `Undefined runtime variable(s): ${missingList}. Available top-level runtime keys: ${availableText}. Template: ${value}`
    )
  }

  return rendered
}

export function setRuntimeVariable(runtimeVariables, outputPath, value) {
  const keys = String(outputPath || "").split(".").filter(Boolean)
  if (keys.length === 0) {
    throw new Error("extract-pdf-code requires a non-empty output path.")
  }

  let cursor = runtimeVariables
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }

  cursor[keys[keys.length - 1]] = value
}

function cloneRuntimeVariableValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneRuntimeVariableValue(entry))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneRuntimeVariableValue(entry)]),
    )
  }
  return value
}

export function cloneRuntimeVariables(runtimeVariables) {
  if (!runtimeVariables || typeof runtimeVariables !== 'object') {
    return {}
  }

  return cloneRuntimeVariableValue(runtimeVariables)
}

export function seedRuntimeVariables(runtimeVariables, initialRuntimeVariables, { overwrite = true } = {}) {
  if (!runtimeVariables || typeof runtimeVariables !== 'object') {
    return runtimeVariables
  }
  if (!initialRuntimeVariables || typeof initialRuntimeVariables !== 'object') {
    return runtimeVariables
  }

  for (const [key, value] of Object.entries(initialRuntimeVariables)) {
    if (!overwrite && getPathValue(runtimeVariables, key) !== undefined) {
      continue
    }
    setRuntimeVariable(runtimeVariables, key, cloneRuntimeVariableValue(value))
  }

  return runtimeVariables
}

function tryParseJson(value) {
  if (typeof value !== 'string') {
    return { ok: true, value }
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return { ok: false, value: trimmed }
  }

  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    return { ok: false, value: trimmed }
  }
}

function tokenizeApiParameterPath(path) {
  const normalized = String(path || '').trim()
  if (!normalized) {
    return []
  }

  const tokens = []
  const pattern = /([^.[\]]+)|\[(\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]/g
  let match

  while ((match = pattern.exec(normalized)) !== null) {
    if (match[1] != null) {
      tokens.push(match[1])
      continue
    }

    const bracketValue = String(match[2] || '')
    if (/^\d+$/.test(bracketValue)) {
      tokens.push(Number(bracketValue))
      continue
    }

    tokens.push(bracketValue.slice(1, -1))
  }

  return tokens
}

function readValueFromApiPayload(payload, parameter) {
  const tokens = tokenizeApiParameterPath(parameter)
  if (tokens.length === 0) {
    return payload
  }

  let current = payload
  for (const token of tokens) {
    if (current == null) {
      throw new Error(`API response path "${parameter}" konnte nicht gelesen werden.`)
    }

    if (typeof token === 'number') {
      if (!Array.isArray(current)) {
        throw new Error(`API response path "${parameter}" erwartet an dieser Stelle ein Array.`)
      }
      current = current[token]
      continue
    }

    if (typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, token)) {
      throw new Error(`API response path "${parameter}" enthaelt kein Feld "${token}".`)
    }
    current = current[token]
  }

  return current
}

export async function executeScenarioApiRequest({
  method,
  url,
  payloadTemplate = '',
  runtimeVariables = {},
}) {
  const normalizedMethod = String(method || '').trim().toUpperCase()
  const normalizedUrl = String(url || '').trim()
  if (!['GET', 'POST'].includes(normalizedMethod)) {
    throw new Error(`Unsupported API method: ${method}`)
  }
  if (!normalizedUrl) {
    throw new Error('API request requires a non-empty url.')
  }

  const resolvedPayloadText = resolveRuntimeTemplateString(String(payloadTemplate ?? ''), runtimeVariables)
  const parsedPayload = tryParseJson(resolvedPayloadText)
  const requestInit = {
    method: normalizedMethod,
    headers: {},
  }

  if (resolvedPayloadText.trim()) {
    if (parsedPayload.ok && typeof parsedPayload.value === 'object') {
      requestInit.headers['content-type'] = 'application/json'
      requestInit.body = JSON.stringify(parsedPayload.value)
    } else {
      requestInit.body = resolvedPayloadText
    }
  }

  const response = await fetch(normalizedUrl, requestInit)
  const responseText = await response.text()
  const parsedResponse = tryParseJson(responseText)
  if (!response.ok) {
    throw new Error(`API request failed (${response.status} ${response.statusText}) for ${normalizedMethod} ${normalizedUrl}: ${responseText.slice(0, 400)}`)
  }

  return {
    method: normalizedMethod,
    url: normalizedUrl,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText: responseText,
    body: parsedResponse.ok ? parsedResponse.value : responseText,
  }
}

export function readScenarioApiResponseValue(apiResponse, parameter = '', regex = '') {
  const payload = apiResponse?.body
  const value = readValueFromApiPayload(payload, parameter)
  let normalizedValue = value
  if (normalizedValue != null && typeof normalizedValue === 'object') {
    normalizedValue = JSON.stringify(normalizedValue)
  }
  if (normalizedValue != null && typeof normalizedValue !== 'string') {
    normalizedValue = String(normalizedValue)
  }

  const normalizedRegex = String(regex || '').trim()
  if (!normalizedRegex) {
    return normalizedValue
  }

  const match = String(normalizedValue ?? '').match(new RegExp(normalizedRegex))
  if (!match) {
    throw new Error(`API response value did not match regex "${normalizedRegex}".`)
  }
  if (match[1] != null) {
    return String(match[1])
  }
  return String(match[0] ?? '')
}

function parseCsvRow(line, delimiter) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const nextChar = line[index + 1]

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"'
        index += 1
        continue
      }
      inQuotes = !inQuotes
      continue
    }

    if (char === delimiter && !inQuotes) {
      values.push(current)
      current = ''
      continue
    }

    current += char
  }

  values.push(current)
  return values.map((value) => String(value || '').trim())
}

function parseCsvTable(csvText) {
  const normalized = String(csvText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) {
    return { headers: [], rows: [] }
  }

  const headerLine = lines[0]
  const semicolonCount = (headerLine.match(/;/g) || []).length
  const commaCount = (headerLine.match(/,/g) || []).length
  const delimiter = semicolonCount >= commaCount ? ';' : ','
  const headers = parseCsvRow(headerLine, delimiter)
  const rows = lines.slice(1).map((line) => parseCsvRow(line, delimiter))
  return { headers, rows }
}

function normalizeCsvHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function normalizeNameValue(value) {
  return String(value || '').trim().toLowerCase()
}

function findFirstHeaderIndex(normalizedHeaders, aliases) {
  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(normalizeCsvHeader(alias))
    if (index >= 0) {
      return index
    }
  }
  return -1
}

export async function readActivationCodeFromMailhog({
  mailhogUrl,
  vornamen,
  familienname,
  zeilenIndex = null,
  attachmentPartIndex = 2,
  activationCodeColumn = 'aktivierungscode',
  timeoutMs = 10000,
  pollMs = 500,
}) {
  const baseUrl = String(mailhogUrl || '').trim().replace(/\/+$/, '')
  if (!baseUrl) {
    throw new Error('MailHog-URL fehlt. Erwartet als "url"-Attribut im Schritt PinBriefMailAuslesen.')
  }

  const deadlineAt = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  const effectivePollMs = Math.max(50, Number(pollMs) || 500)
  const normalizedZeilenIndex = zeilenIndex == null || zeilenIndex === ''
    ? null
    : Number(zeilenIndex)
  const normalizedVornamen = normalizeNameValue(vornamen)
  const normalizedFamilienname = normalizeNameValue(familienname)
  let lastError = null

  while (Date.now() <= deadlineAt) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/messages`)
      if (!response.ok) {
        throw new Error(`MailHog messages API fehlgeschlagen (${response.status} ${response.statusText}).`)
      }

      const payload = await response.json()
      const messages = Array.isArray(payload?.messages)
        ? payload.messages
        : (Array.isArray(payload?.items) ? payload.items : [])
      if (messages.length === 0) {
        throw new Error('MailHog liefert keine Nachrichten.')
      }

      const messageId = String(messages[0]?.ID || messages[0]?.id || '').trim()
      if (!messageId) {
        throw new Error('MailHog-Nachricht enthaelt keine ID.')
      }

      const attachmentResponse = await fetch(`${baseUrl}/api/v1/message/${encodeURIComponent(messageId)}/part/${Number(attachmentPartIndex) || 2}`)
      if (!attachmentResponse.ok) {
        throw new Error(`MailHog attachment API fehlgeschlagen (${attachmentResponse.status} ${attachmentResponse.statusText}).`)
      }

      const csvText = await attachmentResponse.text()
      const { headers, rows } = parseCsvTable(csvText)
      if (headers.length === 0) {
        throw new Error('MailHog-CSV ist leer oder enthaelt keine Header-Zeile.')
      }

      const normalizedHeaders = headers.map(normalizeCsvHeader)
      const vornameIndex = findFirstHeaderIndex(normalizedHeaders, ['vorname', 'vornamen', 'firstname', 'first_name'])
      const nachnameIndex = findFirstHeaderIndex(normalizedHeaders, ['nachname', 'familienname', 'surname', 'lastname', 'last_name'])
      const activationCodeIndex = findFirstHeaderIndex(normalizedHeaders, [activationCodeColumn])

      if (vornameIndex < 0 || nachnameIndex < 0 || activationCodeIndex < 0) {
        throw new Error(`MailHog-CSV enthaelt nicht die erwarteten Spalten fuer Vorname, Nachname und ${activationCodeColumn}.`)
      }

      let matchingRow = null
      if (normalizedZeilenIndex != null) {
        if (!Number.isInteger(normalizedZeilenIndex) || normalizedZeilenIndex < 0) {
          throw new Error('zeilen-index muss eine nicht-negative Ganzzahl sein.')
        }
        matchingRow = rows[normalizedZeilenIndex] || null
        if (!matchingRow) {
          throw new Error(`Kein CSV-Eintrag fuer zeilen-index ${normalizedZeilenIndex} gefunden.`)
        }
      } else {
        matchingRow = rows.find((row) => (
          normalizeNameValue(row[vornameIndex]) === normalizedVornamen
          && normalizeNameValue(row[nachnameIndex]) === normalizedFamilienname
        ))
      }

      if (!matchingRow) {
        throw new Error(`Kein CSV-Eintrag fuer ${vornamen} ${familienname} gefunden.`)
      }

      const activationCode = String(matchingRow[activationCodeIndex] || '').trim()
      if (!activationCode) {
        throw new Error(`CSV-Eintrag fuer ${vornamen} ${familienname} enthaelt keinen Aktivierungscode.`)
      }

      return activationCode
    } catch (error) {
      lastError = error
      if (Date.now() > deadlineAt) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, effectivePollMs))
    }
  }

  throw lastError || new Error(`Aktivierungscode fuer ${vornamen} ${familienname} konnte nicht aus MailHog gelesen werden.`)
}

export function createStepDomIdentifierLogger({ page, testInfo, enabled = false, maxNodesPerStep = 1200 }) {
  const entries = []
  const isEnabled = Boolean(enabled)

  async function capture(stepId, phase, meta = {}) {
    if (!isEnabled) {
      return
    }

    try {
      const snapshot = await page.evaluate(({ maxNodes }) => {
        const nodes = Array.from(document.querySelectorAll("[data-id], [data-testid], [id]"))
        const identifiers = []
        let truncated = false

        for (const el of nodes) {
          const rect = el.getBoundingClientRect()
          const style = window.getComputedStyle(el)
          const isVisible = Boolean(
            rect && rect.width > 0 && rect.height > 0 && style && style.display !== "none" && style.visibility !== "hidden"
          )
          if (!isVisible) {
            continue
          }

          const ariaState = {}
          for (const attr of Array.from(el.attributes || [])) {
            if (attr && typeof attr.name === "string" && attr.name.startsWith("aria-")) {
              ariaState[attr.name] = attr.value
            }
          }

          identifiers.push({
            tag: String(el.tagName || "").toLowerCase(),
            dataId: el.getAttribute("data-id"),
            testId: el.getAttribute("data-testid"),
            id: el.id || null,
            ariaLabel: el.getAttribute("aria-label"),
            ariaState,
            text: String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
          })

          if (identifiers.length >= maxNodes) {
            truncated = true
            break
          }
        }

        return {
          url: window.location.href,
          identifiers,
          truncated,
        }
      }, { maxNodes: Number(maxNodesPerStep) || 1200 })

      entries.push({
        timestamp: new Date().toISOString(),
        stepId: String(stepId || ""),
        phase: String(phase || "step"),
        url: snapshot.url,
        truncated: Boolean(snapshot.truncated),
        count: Array.isArray(snapshot.identifiers) ? snapshot.identifiers.length : 0,
        meta: meta || {},
        identifiers: Array.isArray(snapshot.identifiers) ? snapshot.identifiers : [],
      })
    } catch (error) {
      entries.push({
        timestamp: new Date().toISOString(),
        stepId: String(stepId || ""),
        phase: String(phase || "step"),
        url: page.url(),
        meta: meta || {},
        identifiers: [],
        error: String(error && error.message ? error.message : error),
      })
    }
  }

  async function flush() {
    if (!isEnabled) {
      return
    }

    try {
      const outputPath = testInfo.outputPath("step-dom-identifiers.json")
      await writeFile(
        outputPath,
        JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2),
        "utf8"
      )
      console.log(`[scenario-step-identifiers] ${outputPath}`)
    } catch (error) {
      console.warn(`[scenario-step-identifiers] Failed to write JSON log: ${String(error && error.message ? error.message : error)}`)
    }
  }

  return { capture, flush }
}

function buildTargetSelectorSummaryParts(target = {}, options = {}) {
  const parts = []
  const pushPart = (label, value, { regex = false } = {}) => {
    if (value == null) {
      return
    }
    const text = String(value).replace(/\s+/g, ' ').trim()
    if (!text) {
      return
    }
    parts.push(regex ? `${label}=/${text}/` : `${label}=${text}`)
  }

  const useRegex = parseTargetRegexFlag(target)
  pushPart('testid', target.testid, { regex: useRegex })
  pushPart('id', target.id)
  pushPart('data-id', target['data-id'], { regex: useRegex })
  pushPart('label', target.label, { regex: useRegex })
  pushPart('aria-label', target['aria-label'], { regex: useRegex })
  pushPart('role', target.role)
  pushPart('text', target.text, { regex: useRegex })
  pushPart('komponententyp', target.komponententyp)
  pushPart('target-index', resolveTargetIndex(target))
  if (options.genericSelector) {
    pushPart('selector', options.genericSelector)
  }
  return parts
}

async function countLocatorMatches(locator, target = {}) {
  const komponententypSelector = resolveKomponententypSelector(target?.komponententyp)
  if (!komponententypSelector) {
    return locator.count()
  }

  const matchIndexes = await locator.evaluateAll((elements, payload) => {
    const indexes = []
    elements.forEach((element, index) => {
      try {
        if (element.matches(payload.komponententypSelector) || element.querySelector(payload.komponententypSelector)) {
          indexes.push(index)
        }
      } catch {
        // Ignore invalid selector matches for this candidate.
      }
    })
    return indexes
  }, { komponententypSelector })

  return matchIndexes.length
}

async function countAttributeMatches(page, attrName, value, target = {}, options = {}) {
  const useRegex = parseTargetRegexFlag(target)
  const preferredControl = options?.preferredControl || null
  const komponententypSelector = resolveKomponententypSelector(target?.komponententyp)
  const baseLocator = page.locator(`[${attrName}]`)
  const matchIndexes = await baseLocator.evaluateAll((elements, payload) => {
    const indexes = []
    elements.forEach((element, index) => {
      const attrValue = element.getAttribute(payload.attrName)
      if (attrValue == null) {
        return
      }

      const isMatch = payload.useRegex
        ? new RegExp(String(payload.pattern ?? '')).test(attrValue)
        : attrValue === String(payload.pattern ?? '')

      if (!isMatch) {
        return
      }

      const tagName = String(element?.tagName || '').toLowerCase()
      const role = String(element?.getAttribute?.('role') || '').toLowerCase()
      const className = String(element?.className || '')
      const isContentEditable = Boolean(element?.isContentEditable)
      const hasPopup = String(element?.getAttribute?.('aria-haspopup') || '').length > 0

      let matchesPreferredControl = true
      if (payload.preferredControl === 'fill') {
        matchesPreferredControl =
          tagName === 'input'
          || tagName === 'textarea'
          || tagName === 'select'
          || isContentEditable
          || role === 'textbox'
          || Boolean(element?.querySelector?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
      } else if (payload.preferredControl === 'select') {
        matchesPreferredControl =
          tagName === 'select'
          || role === 'combobox'
          || className.includes('q-field__native')
          || hasPopup
          || Boolean(element?.querySelector?.('select, [role="combobox"], input.q-field__native, .q-field__native, input'))
      }

      let matchesKomponententyp = true
      if (payload.komponententypSelector) {
        try {
          matchesKomponententyp =
            element.matches(payload.komponententypSelector)
            || Boolean(element.querySelector(payload.komponententypSelector))
        } catch {
          matchesKomponententyp = false
        }
      }

      if (matchesPreferredControl && matchesKomponententyp) {
        indexes.push(index)
      }
    })
    return indexes
  }, {
    attrName,
    pattern: String(value ?? ''),
    useRegex,
    preferredControl,
    komponententypSelector,
  })

  return matchIndexes.length
}

export async function describeTargetAvailability(page, target = {}, options = {}) {
  const textMode = String(options?.textMode || 'text')
  const useRegex = parseTargetRegexFlag(target)
  const preferredControl = options?.preferredControl || null
  const genericSelector = String(options?.genericSelector || '').trim()
  const selectors = buildTargetSelectorSummaryParts(target, { genericSelector })

  let count = 0
  let strategy = 'unknown'
  if (target.testid) {
    strategy = 'testid'
    count = await countLocatorMatches(buildTestIdLocator(page, target.testid, target), target)
  } else if (target.id) {
    strategy = 'id'
    count = await countLocatorMatches(page.locator(buildExactAttributeSelector('id', target.id)), target)
  } else if (target['data-id']) {
    strategy = 'data-id'
    count = await countAttributeMatches(page, 'data-id', target['data-id'], target, { preferredControl })
  } else if (target.label) {
    strategy = 'label'
    count = await countAttributeMatches(page, 'label', target.label, target, { preferredControl })
  } else if (target['aria-label']) {
    strategy = 'aria-label'
    count = await countAttributeMatches(page, 'aria-label', target['aria-label'], target, { preferredControl })
  } else if (target.role) {
    strategy = 'role'
    const roleName = String(target.role)
    const locator = target.text
      ? (
          useRegex
            ? page.getByRole(roleName, { name: buildRegexMatcher(target.text) })
            : page.getByRole(roleName, { name: String(target.text), exact: true })
        )
      : page.getByRole(roleName)
    count = await countLocatorMatches(locator, target)
  } else if (target.text) {
    strategy = textMode === 'label' ? 'label-text' : 'text'
    const locator = textMode === 'label'
      ? (
          useRegex
            ? page.getByLabel(buildRegexMatcher(target.text))
            : page.getByLabel(String(target.text), { exact: true })
        )
      : (
          useRegex
            ? page.getByText(buildRegexMatcher(target.text))
            : page.getByText(String(target.text), { exact: true })
        )
    count = await countLocatorMatches(locator, target)
  } else if (genericSelector) {
    strategy = 'generic-selector'
    count = await countLocatorMatches(page.locator(genericSelector), target)
  } else {
    throw new Error('Target could not be resolved to a locator.')
  }

  return {
    count,
    strategy,
    selectors,
    preferredControl,
    textMode,
    targetIndex: resolveTargetIndex(target),
  }
}

async function readValueFromElement(locator, elementInfo) {
  if (elementInfo.tagName === 'input' || elementInfo.tagName === 'textarea') {
    return locator.inputValue()
  }

  if (elementInfo.isContentEditable) {
    return locator.evaluate((el) => el.textContent || "")
  }

  return locator.evaluate((el) => el.getAttribute("value") ?? "")
}

async function readComparableValue(locator) {
  return locator.evaluate((el) => {
    const tagName = el.tagName?.toLowerCase?.() || ''
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
      return String(el.value ?? "")
    }

    const attrValue = el.getAttribute("value")
    if (attrValue != null) {
      return String(attrValue)
    }

    return String(el.textContent || "").trim()
  })
}

async function assertComparableValue(locator, targetLabel, expectedValue) {
  await locator.waitFor({ state: 'visible' })
  const normalizedExpected = String(expectedValue ?? "")
  const actualValue = await readComparableValue(locator)
  if (actualValue !== normalizedExpected) {
    throw new Error(`Assert failed for ${targetLabel}. Expected "${normalizedExpected}", got "${actualValue}".`)
  }
}

function resolveTargetIndex(options = {}) {
  const rawIndex = options?.targetIndex ?? options?.['treffer-index'] ?? options?.index
  const index = Number(rawIndex)
  return Number.isInteger(index) ? index : null
}

export async function pickIndexedLocator(locator, rawIndex) {
  const index = resolveTargetIndex({ targetIndex: rawIndex })
  if (index == null) {
    return locator.first()
  }
  if (index >= 0) {
    return locator.nth(index)
  }

  const count = await locator.count()
  const resolvedIndex = count + index
  if (resolvedIndex < 0) {
    throw new Error(`Negative target index ${index} is out of range for locator with ${count} matches.`)
  }

  return locator.nth(resolvedIndex)
}

async function pickLocator(locator, options = {}) {
  return pickIndexedLocator(locator, resolveTargetIndex(options))
}

function isEditableTagName(tagName) {
  const normalizedTagName = String(tagName || '').toLowerCase()
  return normalizedTagName === 'input' || normalizedTagName === 'textarea' || normalizedTagName === 'select'
}

function parseTargetRegexFlag(target = {}) {
  const raw = target?.['selektor-regex']
  if (raw === true || raw === 1) {
    return true
  }
  if (typeof raw === 'string') {
    return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase())
  }
  return false
}

function buildRegexMatcher(pattern) {
  return new RegExp(String(pattern ?? ''))
}

function buildTestIdLocator(page, rawTestId, target = {}) {
  const matcher = parseTargetRegexFlag(target)
    ? buildRegexMatcher(rawTestId)
    : String(rawTestId)
  return page.getByTestId(matcher)
}

function buildConditionCandidateSelector(target = {}) {
  if (target.testid) {
    return '[data-testid]'
  }
  if (target.id) {
    return '[id]'
  }
  if (target['data-id']) {
    return '[data-id]'
  }
  if (target['aria-label']) {
    return '[aria-label]'
  }
  if (target.class) {
    return '[class]'
  }
  if (target.label) {
    return '[label], [aria-label], input, textarea, select, [role="textbox"]'
  }
  if (target.role) {
    return `[role=${JSON.stringify(String(target.role))}]`
  }
  return '*'
}

async function evaluateTargetVisibilityState(page, target = {}, options = {}) {
  const payload = {
    selector: buildConditionCandidateSelector(target),
    useRegex: parseTargetRegexFlag(target),
    textMode: String(options?.textMode || 'text'),
    targetIndex: resolveTargetIndex(target),
    target: {
      testid: target.testid == null ? null : String(target.testid),
      id: target.id == null ? null : String(target.id),
      dataId: target['data-id'] == null ? null : String(target['data-id']),
      label: target.label == null ? null : String(target.label),
      ariaLabel: target['aria-label'] == null ? null : String(target['aria-label']),
      className: target.class == null ? null : String(target.class),
      role: target.role == null ? null : String(target.role),
      text: target.text == null ? null : String(target.text),
      komponententyp: target.komponententyp == null ? null : String(target.komponententyp),
    },
  }

  return page.locator(payload.selector).evaluateAll((elements, config) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
    const matchesText = (actualValue, expectedValue, useRegex) => {
      if (expectedValue == null) {
        return true
      }
      const actual = String(actualValue || '')
      const expected = String(expectedValue || '')
      return useRegex ? new RegExp(expected).test(actual) : actual === expected
    }
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return Boolean(
        rect
        && rect.width > 0
        && rect.height > 0
        && style
        && style.display !== 'none'
        && style.visibility !== 'hidden'
      )
    }

    const matchedIndexes = []
    elements.forEach((element, index) => {
      if (!matchesText(element.getAttribute('data-testid'), config.target.testid, config.useRegex)) {
        return
      }
      if (!matchesText(element.id || '', config.target.id, config.useRegex)) {
        return
      }
      if (!matchesText(element.getAttribute('data-id'), config.target.dataId, config.useRegex)) {
        return
      }
      if (!matchesText(element.getAttribute('label'), config.target.label, config.useRegex)) {
        return
      }
      if (!matchesText(element.getAttribute('aria-label'), config.target.ariaLabel, config.useRegex)) {
        return
      }
      if (!matchesText(element.getAttribute('class'), config.target.className, config.useRegex)) {
        return
      }
      if (config.target.role != null && String(element.getAttribute('role') || '') !== config.target.role) {
        return
      }

      if (config.target.text != null) {
        const actualText = config.textMode === 'label'
          ? normalize(element.getAttribute('aria-label') || element.getAttribute('label') || '')
          : normalize(element.textContent || '')
        const expectedText = config.textMode === 'label'
          ? String(config.target.text)
          : normalize(config.target.text)
        if (!matchesText(actualText, expectedText, config.useRegex)) {
          return
        }
      }

      if (config.target.komponententyp) {
        try {
          if (!element.matches(config.target.komponententyp) && !element.querySelector(config.target.komponententyp)) {
            return
          }
        } catch {
          return
        }
      }

      matchedIndexes.push(index)
    })

    if (matchedIndexes.length === 0) {
      return { count: 0, visibleCount: 0 }
    }

    const requestedIndex = Number.isInteger(config.targetIndex) ? config.targetIndex : null
    const effectiveIndexes = requestedIndex == null
      ? matchedIndexes
      : (() => {
          const resolvedIndex = requestedIndex >= 0
            ? requestedIndex
            : matchedIndexes.length + requestedIndex
          if (resolvedIndex < 0 || resolvedIndex >= matchedIndexes.length) {
            return []
          }
          return [matchedIndexes[resolvedIndex]]
        })()

    const visibleCount = effectiveIndexes.reduce((count, index) => {
      return count + (isVisible(elements[index]) ? 1 : 0)
    }, 0)

    return {
      count: effectiveIndexes.length,
      visibleCount,
    }
  }, payload)
}

function buildExactAttributeSelector(attrName, value) {
  return `[${attrName}=${JSON.stringify(String(value))}]`
}

function resolveKomponententypSelector(rawKomponententyp) {
  const normalized = String(rawKomponententyp || '').trim()
  if (!normalized) {
    return null
  }

  const alias = normalized.toLowerCase()
  if (alias === 'button') {
    return 'button, [role="button"], .q-btn'
  }
  if (alias === 'input' || alias === 'eingabe' || alias === 'textbox') {
    return 'input, textarea, [contenteditable="true"], [role="textbox"]'
  }
  if (alias === 'select' || alias === 'auswahl' || alias === 'combobox') {
    return 'select, [role="combobox"], input.q-field__native, .q-field__native, input[aria-haspopup]'
  }

  return normalized
}

function matchesPreferredControlFromDom(element, preferredControl) {
  if (!preferredControl) {
    return true
  }

  const tagName = String(element?.tagName || '').toLowerCase()
  const role = String(element?.getAttribute?.('role') || '').toLowerCase()
  const className = String(element?.className || '')
  const isContentEditable = Boolean(element?.isContentEditable)
  const hasPopup = String(element?.getAttribute?.('aria-haspopup') || '').length > 0

  if (preferredControl === 'fill') {
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || isContentEditable || role === 'textbox') {
      return true
    }
    return Boolean(element?.querySelector?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
  }

  if (preferredControl === 'select') {
    if (tagName === 'select' || role === 'combobox' || className.includes('q-field__native') || hasPopup) {
      return true
    }
    return Boolean(element?.querySelector?.('select, [role="combobox"], input.q-field__native, .q-field__native, input'))
  }

  return true
}

async function pickAttributeLocator(page, attrName, value, target = {}, options = {}) {
  const useRegex = parseTargetRegexFlag(target)
  const preferredControl = options?.preferredControl || null
  const komponententypSelector = resolveKomponententypSelector(target?.komponententyp)
  const baseLocator = page.locator(`[${attrName}]`)
  const matchIndexes = await baseLocator.evaluateAll((elements, payload) => {
    const indexes = []
    elements.forEach((element, index) => {
      const attrValue = element.getAttribute(payload.attrName)
      if (attrValue == null) {
        return
      }

      const isMatch = payload.useRegex
        ? new RegExp(String(payload.pattern ?? '')).test(attrValue)
        : attrValue === String(payload.pattern ?? '')

      if (!isMatch) {
        return
      }

      const tagName = String(element?.tagName || '').toLowerCase()
      const role = String(element?.getAttribute?.('role') || '').toLowerCase()
      const className = String(element?.className || '')
      const isContentEditable = Boolean(element?.isContentEditable)
      const hasPopup = String(element?.getAttribute?.('aria-haspopup') || '').length > 0

      let matchesPreferredControl = true
      if (payload.preferredControl === 'fill') {
        matchesPreferredControl =
          tagName === 'input'
          || tagName === 'textarea'
          || tagName === 'select'
          || isContentEditable
          || role === 'textbox'
          || Boolean(element?.querySelector?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
      } else if (payload.preferredControl === 'select') {
        matchesPreferredControl =
          tagName === 'select'
          || role === 'combobox'
          || className.includes('q-field__native')
          || hasPopup
          || Boolean(element?.querySelector?.('select, [role="combobox"], input.q-field__native, .q-field__native, input'))
      }

      let matchesKomponententyp = true
      if (payload.komponententypSelector) {
        try {
          matchesKomponententyp =
            element.matches(payload.komponententypSelector)
            || Boolean(element.querySelector(payload.komponententypSelector))
        } catch {
          matchesKomponententyp = false
        }
      }

      if (matchesPreferredControl && matchesKomponententyp) {
        indexes.push(index)
      }
    })
    return indexes
  }, {
    attrName,
    pattern: String(value ?? ''),
    useRegex,
    preferredControl,
    komponententypSelector,
  })

  if (matchIndexes.length === 0) {
    throw new Error(`No element matched ${useRegex ? `/${String(value ?? '')}/` : JSON.stringify(String(value ?? ''))} for attribute "${attrName}".`)
  }

  const logicalIndex = resolveTargetIndex(target) ?? 0
  const resolvedMatchIndex = logicalIndex >= 0 ? logicalIndex : matchIndexes.length + logicalIndex
  if (resolvedMatchIndex < 0 || resolvedMatchIndex >= matchIndexes.length) {
    throw new Error(`Target index ${logicalIndex} is out of range for ${matchIndexes.length} regex matches on attribute "${attrName}".`)
  }

  return baseLocator.nth(matchIndexes[resolvedMatchIndex])
}

async function pickLocatorWithKomponententyp(locator, target = {}, targetLabel = 'locator') {
  const komponententypSelector = resolveKomponententypSelector(target?.komponententyp)
  if (!komponententypSelector) {
    return pickIndexedLocator(locator, resolveTargetIndex(target))
  }

  const matchIndexes = await locator.evaluateAll((elements, payload) => {
    const indexes = []
    elements.forEach((element, index) => {
      try {
        if (element.matches(payload.komponententypSelector) || element.querySelector(payload.komponententypSelector)) {
          indexes.push(index)
        }
      } catch {
        // Ignore invalid selector matches for this candidate.
      }
    })
    return indexes
  }, { komponententypSelector })

  if (matchIndexes.length === 0) {
    throw new Error(`No element matched komponententyp=${JSON.stringify(String(target?.komponententyp || ''))} for ${targetLabel}.`)
  }

  const logicalIndex = resolveTargetIndex(target) ?? 0
  const resolvedMatchIndex = logicalIndex >= 0 ? logicalIndex : matchIndexes.length + logicalIndex
  if (resolvedMatchIndex < 0 || resolvedMatchIndex >= matchIndexes.length) {
    throw new Error(`Target index ${logicalIndex} is out of range for ${matchIndexes.length} komponententyp matches on ${targetLabel}.`)
  }

  return locator.nth(matchIndexes[resolvedMatchIndex])
}

export async function resolveTargetLocator(page, target = {}, options = {}) {
  const textMode = String(options?.textMode || 'text')
  const useRegex = parseTargetRegexFlag(target)
  const preferredControl = options?.preferredControl || null

  if (target.testid) {
    return pickLocatorWithKomponententyp(buildTestIdLocator(page, target.testid, target), target, `data-testid=${JSON.stringify(String(target.testid))}`)
  }
  if (target.id) {
    return pickLocatorWithKomponententyp(page.locator(buildExactAttributeSelector('id', target.id)), target, `id=${JSON.stringify(String(target.id))}`)
  }
  if (target['data-id']) {
    return pickAttributeLocator(page, 'data-id', target['data-id'], target, { preferredControl })
  }
  if (target.label) {
    return pickAttributeLocator(page, 'label', target.label, target, { preferredControl })
  }
  if (target['aria-label']) {
    return pickAttributeLocator(page, 'aria-label', target['aria-label'], target, { preferredControl })
  }
  if (target.class) {
    return pickAttributeLocator(page, 'class', target.class, target, { preferredControl })
  }
  if (target.role) {
    const roleName = String(target.role)
    const locator = target.text
      ? (
          useRegex
            ? page.getByRole(roleName, { name: buildRegexMatcher(target.text) })
            : page.getByRole(roleName, { name: String(target.text), exact: true })
        )
      : page.getByRole(roleName)
    return pickLocatorWithKomponententyp(locator, target, `role=${JSON.stringify(roleName)}`)
  }
  if (target.text) {
    if (textMode === 'label') {
      const locator = useRegex
        ? page.getByLabel(buildRegexMatcher(target.text))
        : page.getByLabel(String(target.text), { exact: true })
      return pickLocatorWithKomponententyp(locator, target, `label=${JSON.stringify(String(target.text))}`)
    }
    if (target.role) {
      const locator = useRegex
        ? page.getByRole(String(target.role), { name: buildRegexMatcher(target.text) })
        : page.getByRole(String(target.role), { name: String(target.text), exact: true })
      return pickLocatorWithKomponententyp(locator, target, `role=${JSON.stringify(String(target.role))}`)
    }
    const locator = useRegex
      ? page.getByText(buildRegexMatcher(target.text))
      : page.getByText(String(target.text), { exact: true })
    return pickLocatorWithKomponententyp(locator, target, `text=${JSON.stringify(String(target.text))}`)
  }

  throw new Error('Target could not be resolved to a locator.')
}

export async function assertElementValueByTestId(page, testId, expectedValue, options = {}) {
  const locator = await pickLocator(buildTestIdLocator(page, testId, options), options)
  await assertComparableValue(locator, `data-testid="${testId}"`, expectedValue)
}

export async function assertElementValueById(page, elementId, expectedValue, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  const targetLabel = selectorType === "data-id" ? `data-id="${elementId}"` : `id="#${elementId}"`
  await assertComparableValue(locator, targetLabel, expectedValue)
}

export async function assertElementValueByLocator(locator, expectedValue, targetLabel = '<target>') {
  await assertComparableValue(locator, targetLabel, expectedValue)
}

async function readConditionTargetValue(locator) {
  try {
    return await readComparableValue(locator)
  } catch {
    return null
  }
}

async function evaluateSingleCondition(page, rawCondition) {
  const condition = rawCondition || {}
  const target = typeof condition.target === "string"
    ? { testid: condition.target }
    : (condition.target || {})
  const state = condition.state || target.state || {}
  const waitMs = Number(state.wait_ms ?? condition.wait_ms ?? 0)

  if (target.url) {
    const expectedUrl = String(target.url)
    const currentUrl = page.url()

    if (state.visible === false) {
      return currentUrl !== expectedUrl
    }

    return currentUrl === expectedUrl
  }

  if (state.visible === true || state.visible === false) {
    const visibilityState = await evaluateTargetVisibilityState(page, target, { textMode: 'text' })
    if (state.visible === true) {
      return visibilityState.visibleCount > 0
    }
    return visibilityState.visibleCount === 0
  }

  let locator = null

  if (parseTargetRegexFlag(target) || target.label || target['aria-label']) {
    locator = await resolveTargetLocator(page, target, { textMode: 'text' })
  } else if (target.testid) {
    locator = await pickLocator(buildTestIdLocator(page, target.testid, target), target)
  } else if (target.id) {
    locator = await pickLocator(page.locator(`[id=${JSON.stringify(String(target.id))}]`), target)
  } else if (target["data-id"]) {
    locator = await pickLocator(page.locator(`[data-id=${JSON.stringify(String(target["data-id"]))}]`), target)
  } else if (target.text) {
    if (target.role) {
      locator = await pickLocator(page.getByRole(String(target.role), { name: String(target.text), exact: true }), target)
    } else {
      locator = await pickLocator(page.getByText(String(target.text), { exact: true }), target)
    }
  } else {
    throw new Error("Condition target must contain one of target.testid, target.id, target.data-id, target.text, or target.url.")
  }

  const count = await locator.count()
  if (count === 0) {
    return false
  }

  let evaluationLocator = locator
  if (count > 1 && state.visible !== false) {
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      const candidateVisible = await candidate.isVisible().catch(() => false)
      if (candidateVisible) {
        evaluationLocator = candidate
        break
      }
    }
  }

  if (state["value-present"] === true) {
    const value = await readConditionTargetValue(evaluationLocator)
    return value != null && value.length > 0
  }

  if (state["value-present"] === false) {
    const value = await readConditionTargetValue(evaluationLocator)
    return value != null && value.length === 0
  }

  const textSelector = state["text-selector"] != null ? String(state["text-selector"]) : null

  if (process.env.SCENARIO_GUARD_DEBUG === "1" && (state.text != null || state["text-contains"] != null)) {
    const label = String(target["data-id"] || target.testid || target.id || target.text || "<unknown-target>")
    for (let index = 0; index < Math.min(count, 5); index += 1) {
      const candidate = locator.nth(index)
      const candidateVisible = await candidate.isVisible().catch(() => false)
      const candidateText = await candidate.evaluate((el, selector) => {
        const source = selector ? el.querySelector(selector) : el
        return String(source?.textContent || "").replace(/\s+/g, " ").trim()
      }, textSelector).catch(() => "")
      console.log(`[guard-debug] target=${label} index=${index} visible=${candidateVisible} text=${JSON.stringify(candidateText)}`)
    }
  }

  if (state.text != null) {
    const actualText = await evaluationLocator.evaluate((el, selector) => {
      const source = selector ? el.querySelector(selector) : el
      return String(source?.textContent || "").replace(/\s+/g, " ").trim()
    }, textSelector)
    const expectedText = String(state.text).replace(/\s+/g, " ").trim()
    return actualText === expectedText
  }

  if (state["text-contains"] != null) {
    const actualText = await evaluationLocator.evaluate((el, selector) => {
      const source = selector ? el.querySelector(selector) : el
      return String(source?.textContent || "").replace(/\s+/g, " ").trim()
    }, textSelector)
    const expectedText = String(state["text-contains"]).replace(/\s+/g, " ").trim()
    return actualText.includes(expectedText)
  }

  if (state["aria-pressed"] != null) {
    const actualPressed = await evaluationLocator.getAttribute("aria-pressed")
    const expectedPressed = state["aria-pressed"]
    if (typeof expectedPressed === "boolean") {
      return String(actualPressed || "").toLowerCase() === String(expectedPressed)
    }
    return String(actualPressed || "") === String(expectedPressed)
  }

  const reservedStateKeys = new Set(["visible", "value-present", "text", "text-contains", "text-selector", "aria-pressed", "wait_ms"])
  for (const [stateKey, expectedStateValue] of Object.entries(state)) {
    if (reservedStateKeys.has(stateKey)) {
      continue
    }

    const actualStateValue = await evaluationLocator.getAttribute(stateKey)
    if (typeof expectedStateValue === "boolean") {
      if (String(actualStateValue || "").toLowerCase() !== String(expectedStateValue)) {
        return false
      }
      continue
    }

    if (String(actualStateValue || "") !== String(expectedStateValue)) {
      return false
    }
  }

  if (condition.value != null) {
    const value = await readConditionTargetValue(evaluationLocator)
    return value === String(condition.value)
  }

  return true
}

async function evaluateConditions(page, conditions) {
  for (const condition of conditions || []) {
    const conditionPassed = await evaluateSingleCondition(page, condition)
    if (!conditionPassed) {
      return false
    }
  }

  return true
}

export async function shouldRunStepFromGuards(page, stepGuards) {
  const guards = stepGuards || {}
  const ifConditions = Array.isArray(guards.if) ? guards.if : []
  const ifNotConditions = Array.isArray(guards.ifnot) ? guards.ifnot : []

  if (ifConditions.length > 0) {
    const ifPassed = await evaluateConditions(page, ifConditions)
    if (!ifPassed) {
      return false
    }
  }

  if (ifNotConditions.length > 0) {
    const ifNotPassed = await evaluateConditions(page, ifNotConditions)
    if (ifNotPassed) {
      return false
    }
  }

  return true
}

export async function waitForCondition(page, condition, timeoutMs = 5000, pollMs = 100) {
  const timeout = Math.max(0, Number(timeoutMs) || 0)
  const poll = Math.max(25, Number(pollMs) || 100)
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt <= timeout) {
    try {
      const passed = await evaluateSingleCondition(page, condition)
      if (passed) {
        return
      }
    } catch (error) {
      lastError = error
    }

    await page.waitForTimeout(poll)
  }

  const target = condition && typeof condition === "object" ? (condition.target || {}) : {}
  const targetLabel = target["data-id"] || target.testid || target.id || target.text || target.url || "<unknown target>"
  const suffix = lastError ? ` Last evaluation error: ${String(lastError && lastError.message ? lastError.message : lastError)}` : ""
  throw new Error(`Wait condition timed out after ${timeout}ms for ${targetLabel}.${suffix}`)
}

export async function scrollToLocator(page, locator, options = {}) {
  const stepDelayMs = Math.max(0, Number(options.stepDelayMs ?? 35) || 35)
  const stepPx = Math.max(1, Number(options.stepPx ?? defaultScrollStepPx ?? 20) || 20)
  const maxSteps = Math.max(20, Number(options.maxSteps ?? 220) || 220)
  const focus = options.focus === true
  const onlyIfNotVisible = options.onlyIfNotVisible === true
  const attachTimeoutMs = Math.max(250, Number(options.attachTimeoutMs ?? 2500) || 2500)

  await locator.waitFor({ state: "attached", timeout: attachTimeoutMs })

  const scrollResult = await locator.evaluate(async (element, config) => {
    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function isInViewport(el) {
      const rect = el.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return false
      }
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
    }

    function getScrollableAncestor(start) {
      let current = start?.parentElement || null
      while (current) {
        const style = window.getComputedStyle(current)
        const overflowY = style.overflowY || style.overflow || ""
        const overflowX = style.overflowX || style.overflow || ""
        const isScrollableY = /(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight
        const isScrollableX = /(auto|scroll|overlay)/.test(overflowX) && current.scrollWidth > current.clientWidth
        if (isScrollableY || isScrollableX) {
          return current
        }
        current = current.parentElement
      }
      return document.scrollingElement || document.documentElement
    }

    const container = getScrollableAncestor(element)
    if (config.onlyIfNotVisible && isInViewport(element)) {
      return { reachedTarget: true, moved: false, direction: null }
    }
    // Erlaubte Distanz, sodass nicht mehr gescrollt wird.
    const epsilon = 2

    let moved = false
    let totalDeltaX = 0
    let totalDeltaY = 0

    for (let i = 0; i < config.maxSteps; i += 1) {
      const elementRect = element.getBoundingClientRect()
      const containerRect = container === document.scrollingElement || container === document.documentElement
        ? { top: 0, left: 0, height: window.innerHeight, width: window.innerWidth }
        : container.getBoundingClientRect()

      const elementCenter = elementRect.top + (elementRect.height / 2)
      const viewportCenter = containerRect.top + (containerRect.height / 2)
      const elementCenterX = elementRect.left + (elementRect.width / 2)
      const viewportCenterX = containerRect.left + (containerRect.width / 2)
      const deltaY = elementCenter - viewportCenter
      const deltaX = elementCenterX - viewportCenterX

      if (Math.abs(deltaY) <= epsilon && Math.abs(deltaX) <= epsilon) {
        const direction = Math.abs(totalDeltaY) >= Math.abs(totalDeltaX)
          ? (totalDeltaY > 0 ? 'runter' : totalDeltaY < 0 ? 'hoch' : null)
          : (totalDeltaX > 0 ? 'rechts' : totalDeltaX < 0 ? 'links' : null)
        return { reachedTarget: true, moved, direction }
      }

      const scrollVertically = Math.abs(deltaY) >= Math.abs(deltaX)
      const stepY = scrollVertically
        ? Math.sign(deltaY) * Math.min(Math.abs(deltaY), config.stepPx)
        : 0
      const stepX = scrollVertically
        ? 0
        : Math.sign(deltaX) * Math.min(Math.abs(deltaX), config.stepPx)
      if (container === document.scrollingElement || container === document.documentElement) {
        window.scrollBy(stepX, stepY)
      } else {
        container.scrollBy(stepX, stepY)
      }
      if (Math.abs(stepX) > 0 || Math.abs(stepY) > 0) {
        moved = true
        totalDeltaX += stepX
        totalDeltaY += stepY
      }

      if (config.stepDelayMs > 0) {
        await delay(config.stepDelayMs)
      }
    }

    const direction = Math.abs(totalDeltaY) >= Math.abs(totalDeltaX)
      ? (totalDeltaY > 0 ? 'runter' : totalDeltaY < 0 ? 'hoch' : null)
      : (totalDeltaX > 0 ? 'rechts' : totalDeltaX < 0 ? 'links' : null)
    return { reachedTarget: false, moved, direction }
  }, { stepDelayMs, stepPx, maxSteps, onlyIfNotVisible })

  if (!scrollResult.reachedTarget) {
    await locator.scrollIntoViewIfNeeded()
  }

  await locator.waitFor({ state: "visible" })
  if (focus) {
    await locator.focus().catch(() => {})
  }
  return {
    didScroll: Boolean(scrollResult.moved || !scrollResult.reachedTarget),
    direction: scrollResult.direction ?? null,
  }
}

export async function isLocatorInViewport(page, locator, options = {}) {
  const attachTimeoutMs = Math.max(250, Number(options.attachTimeoutMs ?? 2500) || 2500)
  try {
    await locator.waitFor({ state: "attached", timeout: attachTimeoutMs })
  } catch {
    return false
  }
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return false
    }
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
  })
}

async function ensureLocatorScroll(page, locator, options = {}) {
  const skipAutoScroll = options && options.skipAutoScroll === true
  if (skipAutoScroll) {
    await locator.waitFor({ state: "attached" })
    return
  }
  const smoothScroll = options && options.smoothScroll === true
  const stepDelayMs = Math.max(0, Number(options?.stepDelayMs ?? 35) || 35)
  if (smoothScroll) {
    await scrollToLocator(page, locator, { stepDelayMs, onlyIfNotVisible: true })
  } else {
    await locator.scrollIntoViewIfNeeded()
    await locator.waitFor({ state: "visible" })
  }
}

async function applyDefaultFillStrategy(page, locator, expectedValue, elementInfo, testId, mode = "fill") {
  if (elementInfo.tagName === 'input' || elementInfo.tagName === 'textarea') {
    await locator.click()
    if (mode === 'append') {
      await locator.press('End')
    } else {
      await locator.press('Control+a')
      await locator.press('Backspace')
    }
    if (expectedValue) {
      await locator.type(expectedValue, { delay: 35 })
    }
    await locator.dispatchEvent("input")
    await locator.dispatchEvent("change")
    await locator.press('Tab')
    return
  }

  if (elementInfo.isContentEditable) {
    await locator.click()
    if (mode === 'append') {
      await page.keyboard.press('Control+End').catch(() => {})
      if (expectedValue) {
        await locator.type(expectedValue, { delay: 35 })
      }
    } else {
      await page.keyboard.press('Control+a')
      if (expectedValue) {
        await locator.type(expectedValue, { delay: 35 })
      } else {
        await page.keyboard.press('Backspace')
      }
    }
    await locator.dispatchEvent("input")
    await locator.dispatchEvent("change")
    return
  }

  throw new Error(
    `Fill is not supported for data-testid="${testId}" (<${elementInfo.tagName || "unknown"}>) because it is neither input/textarea nor contenteditable.`
  )
}

async function resolveSelectControlLocator(locator) {
  const rootLocator = locator.first()
  await rootLocator.waitFor({ state: "attached" })

  const rootElementInfo = await rootLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    className: String(el.className || ''),
    role: el.getAttribute?.('role') || '',
  })).catch(() => null)

  if (rootElementInfo) {
    const rootTagName = String(rootElementInfo.tagName || '')
    const rootClassName = String(rootElementInfo.className || '')
    const rootRole = String(rootElementInfo.role || '')

    if (
      rootTagName === 'select'
      || rootTagName === 'input'
      || rootRole === 'combobox'
      || rootClassName.includes('q-field__native')
    ) {
      return rootLocator
    }
  }

  const candidateSelectors = [
    'select',
    '[role="combobox"]',
    'input.q-field__native',
    '.q-field__native',
    'input',
  ]

  for (const selector of candidateSelectors) {
    const candidate = rootLocator.locator(selector).first()
    const count = await candidate.count().catch(() => 0)
    if (count > 0) {
      return candidate
    }
  }

  return rootLocator
}

async function resolveFillControlLocator(locator) {
  const rootLocator = locator.first()
  await rootLocator.waitFor({ state: "attached" })

  const rootElementInfo = await rootLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    isContentEditable: Boolean(el.isContentEditable),
  })).catch(() => null)

  if (rootElementInfo && (isEditableTagName(rootElementInfo.tagName) || rootElementInfo.isContentEditable)) {
    return rootLocator
  }

  const candidateSelectors = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role="textbox"]',
  ]

  for (const selector of candidateSelectors) {
    const candidate = rootLocator.locator(selector).first()
    const count = await candidate.count().catch(() => 0)
    if (count > 0) {
      return candidate
    }
  }

  throw new Error('Target did not resolve to an input-capable element.')
}

async function applyDefaultSelectStrategy(page, locator, expectedValue, elementInfo, targetLabel) {
  if (elementInfo.tagName === 'select') {
    await locator.selectOption({ label: expectedValue }).catch(async () => {
      await locator.selectOption(expectedValue)
    })
    return
  }

  throw new Error(`No select strategy found for ${targetLabel}. Add a strategy to env/fill-strategies.mjs for this component.`)
}

export async function applyFillValue(page, testId, value, options = {}) {
  const locator = await pickLocator(buildTestIdLocator(page, testId, options), options)
  return applyFillValueToLocator(page, locator, value, { targetLabel: `data-testid="${testId}"` }, options)
}

export async function applyFillValueToLocator(page, locator, value, meta = {}, options = {}) {
  const controlLocator = await resolveFillControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)
  const fillPoint = buildInteractionPointFromBox(await captureLocatorBox(controlLocator))

  const elementInfo = await controlLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    isContentEditable: Boolean(el.isContentEditable),
    className: String(el.className || ""),
    modelValue: el.getAttribute("model-value"),
    role: el.getAttribute("role"),
  }))

  const expectedValue = String(value ?? "")
  const targetLabel = String(meta?.targetLabel || '<target>')

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({ testId: targetLabel, elementInfo, expectedValue })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({ page, locator: controlLocator, testId: targetLabel, elementInfo, expectedValue })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return { fillPoint }
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, targetLabel)
  return { fillPoint }
}

export async function applyFillValueById(page, elementId, value, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  return applyFillValueToLocator(
    page,
    locator,
    value,
    { targetLabel: selectorType === 'data-id' ? `data-id="${elementId}"` : `id="#${elementId}"` },
    options,
  )
}

function buildReplacedValue(currentValue, searchValue, replaceValue, options = {}) {
  const sourceText = String(currentValue ?? "")
  const searchText = String(searchValue ?? "")
  const replacementText = String(replaceValue ?? "")
  const useRegex = options?.replaceRegex === true

  if (!searchText) {
    throw new Error('Replace requires a non-empty searchValue.')
  }

  if (useRegex) {
    return sourceText.replace(new RegExp(searchText, 'g'), replacementText)
  }

  return sourceText.split(searchText).join(replacementText)
}

export async function applyReplaceValue(page, testId, searchValue, replaceValue, options = {}) {
  const locator = await pickLocator(buildTestIdLocator(page, testId, options), options)
  return applyReplaceValueToLocator(page, locator, searchValue, replaceValue, { targetLabel: `data-testid="${testId}"` }, options)
}

export async function applyReplaceValueToLocator(page, locator, searchValue, replaceValue, meta = {}, options = {}) {
  const controlLocator = await resolveFillControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)
  const fillPoint = buildInteractionPointFromBox(await captureLocatorBox(controlLocator))

  const elementInfo = await controlLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    isContentEditable: Boolean(el.isContentEditable),
    className: String(el.className || ""),
    modelValue: el.getAttribute("model-value"),
    role: el.getAttribute("role"),
  }))

  const currentValue = await readValueFromElement(controlLocator, elementInfo)
  const expectedValue = buildReplacedValue(currentValue, searchValue, replaceValue, options)
  const targetLabel = String(meta?.targetLabel || '<target>')

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({
      testId: targetLabel,
      elementInfo,
      expectedValue,
      currentValue,
      searchValue: String(searchValue ?? ""),
      replaceValue: String(replaceValue ?? ""),
      replaceRegex: options?.replaceRegex === true,
      isReplace: true,
    })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({
      page,
      locator: controlLocator,
      testId: targetLabel,
      elementInfo,
      expectedValue,
      currentValue,
      searchValue: String(searchValue ?? ""),
      replaceValue: String(replaceValue ?? ""),
      replaceRegex: options?.replaceRegex === true,
      isReplace: true,
    })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return { fillPoint }
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, targetLabel)
  return { fillPoint }
}

export async function applyReplaceValueById(page, elementId, searchValue, replaceValue, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  const targetLabel = selectorType === 'data-id' ? `data-id="${elementId}"` : `#${elementId}`
  return applyReplaceValueToLocator(page, locator, searchValue, replaceValue, { targetLabel }, options)
}

export async function applySelectValue(page, testId, value, options = {}) {
  const locator = await pickLocator(buildTestIdLocator(page, testId, options), options)
  return applySelectValueToLocator(page, locator, value, { targetLabel: `data-testid="${testId}"` }, options)
}

export async function applySelectValueToLocator(page, locator, value, meta = {}, options = {}) {
  const controlLocator = await resolveSelectControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)

  const elementInfo = await controlLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    className: String(el.className || ''),
    role: el.getAttribute('role'),
    ariaHasPopup: el.getAttribute('aria-haspopup'),
  }))

  const expectedValue = String(value ?? '')
  const targetLabel = String(meta?.targetLabel || '<target>')

  const currentValue = await readComparableValue(controlLocator).catch(() => null)
  if (currentValue != null && String(currentValue).trim() === expectedValue.trim()) {
    return
  }

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({ testId: targetLabel, elementInfo, expectedValue, isSelect: true })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({ page, locator: controlLocator, testId: targetLabel, elementInfo, expectedValue, isSelect: true })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return
    }
  }

  await applyDefaultSelectStrategy(page, controlLocator, expectedValue, elementInfo, targetLabel)
}

export async function applySelectValueById(page, elementId, value, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  const controlLocator = await resolveSelectControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)

  const elementInfo = await controlLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    className: String(el.className || ''),
    role: el.getAttribute('role'),
    ariaHasPopup: el.getAttribute('aria-haspopup'),
  }))

  const expectedValue = String(value ?? '')

  const currentValue = await readComparableValue(controlLocator).catch(() => null)
  if (currentValue != null && String(currentValue).trim() === expectedValue.trim()) {
    return
  }

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({ testId: elementId, elementInfo, expectedValue, isSelect: true })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({ page, locator: controlLocator, testId: elementId, elementInfo, expectedValue, isSelect: true })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return
    }
  }

  await applyDefaultSelectStrategy(page, controlLocator, expectedValue, elementInfo, `id="#${elementId}"`)
}

export async function applyUploadValue(page, testId, value, options = {}) {
  const rootLocator = await pickLocator(buildTestIdLocator(page, testId, options), options)
  return applyUploadValueToLocator(page, rootLocator, value, options)
}

export async function applyUploadValueToLocator(page, rootLocator, value, options = {}) {
  await ensureLocatorScroll(page, rootLocator, options)
  const fileLocator = await resolveUploadLocator(page, rootLocator)
  const uploadInput = await resolveUploadInput(value)
  await fileLocator.setInputFiles(uploadInput)
}

export async function applyUploadValueById(page, elementId, value, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id"
    ? `[data-id=${JSON.stringify(String(elementId))}]`
    : selectorType === "selector"
      ? String(elementId)
      : `[id=${JSON.stringify(String(elementId))}]`
  const rootLocator = await pickLocator(page.locator(selector), options)
  await ensureLocatorScroll(page, rootLocator, options)
  const fileLocator = await resolveUploadLocator(page, rootLocator)
  const uploadInput = await resolveUploadInput(value)
  await fileLocator.setInputFiles(uploadInput)
}

export async function applyAppendValue(page, testId, value, options = {}) {
  const locator = await pickLocator(buildTestIdLocator(page, testId, options), options)
  return applyAppendValueToLocator(page, locator, value, { targetLabel: `data-testid="${testId}"` }, options)
}

export async function applyAppendValueToLocator(page, locator, value, meta = {}, options = {}) {
  const controlLocator = await resolveFillControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)
  const fillPoint = buildInteractionPointFromBox(await captureLocatorBox(controlLocator))

  const elementInfo = await controlLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    isContentEditable: Boolean(el.isContentEditable),
    className: String(el.className || ""),
    modelValue: el.getAttribute("model-value"),
    role: el.getAttribute("role"),
  }))

  const expectedValue = String(value ?? "")
  const targetLabel = String(meta?.targetLabel || '<target>')

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({ testId: targetLabel, elementInfo, expectedValue, isAppend: true })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({ page, locator: controlLocator, testId: targetLabel, elementInfo, expectedValue, isAppend: true })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return { fillPoint }
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, targetLabel, "append")
  return { fillPoint }
}

export async function applyAppendValueById(page, elementId, value, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  return applyAppendValueToLocator(
    page,
    locator,
    value,
    { targetLabel: selectorType === 'data-id' ? `data-id="${elementId}"` : `id="#${elementId}"` },
    options,
  )
}

export async function applyClickValueById(page, elementId, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  return applyClickValueToLocator(page, locator, options, { targetLabel: selectorType === 'data-id' ? `data-id="${elementId}"` : `id="#${elementId}"` })
}

async function captureLocatorBox(locator) {
  const box = await locator.boundingBox().catch(() => null)
  if (!box) {
    return null
  }

  return {
    x: Number(box.x),
    y: Number(box.y),
    width: Number(box.width),
    height: Number(box.height),
  }
}

function buildInteractionPointFromBox(box) {
  if (!box) {
    return null
  }

  return {
    x: Math.round(Number(box.x) + (Number(box.width) / 2)),
    y: Math.round(Number(box.y) + (Number(box.height) / 2)),
  }
}

export async function applyClickValueToLocator(page, locator, options = {}, meta = {}) {
  await ensureLocatorScroll(page, locator, options)
  const clickedElement = await captureLocatorBox(locator)
  const clickPoint = buildInteractionPointFromBox(clickedElement)
  const elementHandle = await locator.elementHandle({ timeout: 2500 }).catch(() => null)
  if (!elementHandle) {
    await clickWithOverlayRecovery(page, locator, options)
    return { clickedElement, clickPoint, clickedAtMs: Date.now() }
  }

  const elementInfo = await elementHandle.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    className: String(el.className || ''),
    role: el.getAttribute('role'),
    ariaHasPopup: el.getAttribute('aria-haspopup'),
  }))

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({ testId: meta?.targetLabel || '<target>', elementInfo, isClick: true })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({ page, locator, testId: meta?.targetLabel || '<target>', elementInfo, isClick: true })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return { clickedElement, clickPoint, clickedAtMs: Date.now() }
    }
  }

  await clickWithOverlayRecovery(page, locator, options)
  return { clickedElement, clickPoint, clickedAtMs: Date.now() }
}

export async function applyClickValueBySelector(page, selector, options = {}) {
  const locator = await pickLocator(page.locator(selector), options)
  return applyClickValueToLocator(page, locator, options, { targetLabel: selector })
}

async function waitForTransientOverlays(page) {
  // Dialog backdrops and toast overlays can temporarily intercept pointer events.
  const overlaySelectors = [
    '#q-portal--dialog--1 .q-dialog__backdrop',
    '#q-notify .q-notification',
  ]
  for (const overlaySelector of overlaySelectors) {
    await page.locator(overlaySelector).first().waitFor({ state: "hidden", timeout: 1500 }).catch(() => {})
  }
}

async function clickWithOverlayRecovery(page, locator, options = {}) {
  await waitForTransientOverlays(page)
  try {
    await locator.click({ timeout: 2500 })
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    if (message.includes("intercepts pointer events")) {
      await waitForTransientOverlays(page)
      await locator.click({ force: true })
      return
    }
    throw error
  }
}

function scenarioTargetNeedsRuntimeLocator(target) {
  return Boolean(target?.role || target?.['selektor-regex'] || target?.label || target?.['aria-label'] || target?.class || target?.komponententyp)
}

function scenarioBuildGenericTargetSelector(target = {}) {
  const reservedKeys = new Set(['testid', 'id', 'data-id', 'text', 'role', 'url', 'state', 'click_child_selector', 'treffer-index', 'selektor-regex', 'label', 'aria-label', 'class', 'komponententyp'])
  const selectorParts = []

  for (const [key, value] of Object.entries(target || {})) {
    if (reservedKeys.has(key) || value == null) {
      continue
    }
    selectorParts.push(`[${key}=${JSON.stringify(String(value))}]`)
  }

  return selectorParts.length > 0 ? selectorParts.join('') : null
}

function scenarioBuildTargetSelectorDescriptions(target = {}) {
  const regexEnabled = parseTargetRegexFlag(target)
  const fields = ['testid', 'data-id', 'id', 'role', 'text', 'label', 'aria-label', 'class', 'selektor-regex', 'treffer-index', 'komponententyp', 'click_child_selector']
  const selectors = []

  for (const field of fields) {
    const value = target[field]
    if (value == null) {
      continue
    }

    const text = String(value).replace(/\s+/g, ' ').trim()
    if (!text) {
      continue
    }

    if (regexEnabled && ['testid', 'data-id', 'text', 'label', 'aria-label', 'class'].includes(field)) {
      selectors.push(`${field}=/${text}/`)
      continue
    }

    selectors.push(`${field}=${text}`)
  }

  const genericSelector = scenarioBuildGenericTargetSelector(target)
  if (genericSelector) {
    selectors.push(`selector=${genericSelector}`)
  }

  return selectors
}

function scenarioBuildStepDescription(step) {
  const stepTitle = typeof step?.resolvedTitle === 'string' ? step.resolvedTitle.trim() : ''
  const interaction = step?.interaction || {}
  const selectors = scenarioBuildTargetSelectorDescriptions(interaction.target || {})
  const descriptionParts = []

  if (interaction.type === 'search-and-select' && interaction.resultSelector) {
    selectors.push(`resultSelector=${String(interaction.resultSelector).trim()}`)
  }
  if (interaction.type === 'read-ui-value' && interaction.output) {
    descriptionParts.push(`read->${String(interaction.output).trim()}`)
  }
  if (interaction.type === 'read-pin-brief-mail' && interaction.output) {
    descriptionParts.push(`mailhog->${String(interaction.output).trim()}`)
  }
  if (selectors.length > 0) {
    descriptionParts.push(`selectors: ${selectors.join(' ; ')}`)
  }

  if (descriptionParts.length === 0) {
    return stepTitle
  }

  return stepTitle
    ? `${stepTitle} | ${descriptionParts.join(' | ')}`
    : descriptionParts.join(' | ')
}

function scenarioBuildStepMeta(step) {
  const interaction = step?.interaction || {}
  const selectors = scenarioBuildTargetSelectorDescriptions(interaction.target || {})
  if (interaction.type === 'search-and-select' && interaction.resultSelector) {
    selectors.push(`resultSelector=${String(interaction.resultSelector).trim()}`)
  }

  return {
    interactionType: interaction.type ? String(interaction.type) : null,
    selectors,
  }
}

function scenarioToConditionList(value, keyName, stepId) {
  if (value == null) {
    return []
  }
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value === 'object') {
    return [value]
  }
  throw new Error(`Step "${stepId}" has invalid "${keyName}" guard. Use an object or array of objects.`)
}

function scenarioHasUsableScrollTarget(target) {
  if (!target || typeof target !== 'object') {
    return false
  }

  if (target.testid || target.id || target['data-id'] || target.text || target.role || target.class) {
    return true
  }

  return scenarioTargetNeedsRuntimeLocator(target) || Boolean(scenarioBuildGenericTargetSelector(target))
}

function scenarioBuildScrollTargetSummary(target = {}) {
  const fields = ['testid', 'data-id', 'id', 'role', 'text', 'label', 'aria-label', 'class', 'selektor-regex', 'treffer-index', 'komponententyp']
  const parts = []

  for (const field of fields) {
    const value = target[field]
    if (value == null) {
      continue
    }

    const text = String(value).replace(/\s+/g, ' ').trim()
    if (!text) {
      continue
    }

    parts.push(`${field}=${text}`)
  }

  const selector = scenarioBuildGenericTargetSelector(target)
  if (selector) {
    parts.push(`selector=${selector}`)
  }

  return parts.join(' | ')
}

function scenarioBuildInjectedAutoScrollResolvedTitle(step) {
  const interaction = step?.interaction || {}
  const targetSummary = scenarioBuildScrollTargetSummary(interaction.target || {})
  const sourceTitle = String(step?.resolvedTitle || '').replace(/\s+/g, ' ').trim()
  const sourceStepId = String(step?.resolvedId || step?.id || '').trim()
  const parts = ['Scroll']

  if (targetSummary) {
    parts.push(targetSummary)
  }
  if (sourceStepId) {
    parts.push(`origin=${sourceStepId}`)
  }
  if (sourceTitle) {
    parts.push(`source=${sourceTitle}`)
  }

  const title = parts.join(' | ')
  return title.length > 220 ? `${title.slice(0, 217)}...` : title
}

function scenarioIsInteractionTypeNeedingAutoScroll(interactionType) {
  return ['click', 'fill', 'append', 'replace', 'select', 'upload', 'search-and-select'].includes(interactionType)
}

function injectAutoScrollSteps(flowEntries, options = {}, path = []) {
  const enabled = options.enabled === true
  const injected = []

  for (let index = 0; index < (flowEntries || []).length; index += 1) {
    const step = flowEntries[index]
    const currentPath = [...path, index]
    const stepId = String(step?.id || `step-${currentPath.join('-')}` || 'step')
    const interaction = step?.interaction || {}
    const interactionType = String(interaction.type || '').trim().toLowerCase()

    if (enabled && scenarioIsInteractionTypeNeedingAutoScroll(interactionType) && scenarioHasUsableScrollTarget(interaction.target)) {
      const onlyIfNotVisible = interactionType === 'select' ? false : true
      const injectedResolvedId = step?.resolvedId
        ? `${String(step.resolvedId).trim()}__autoscroll`
        : `${stepId}__autoscroll`
      injected.push({
        id: `${stepId}__autoscroll`,
        resolvedId: injectedResolvedId,
        resolvedTitle: scenarioBuildInjectedAutoScrollResolvedTitle(step),
        if: step?.if,
        ifnot: step?.ifnot,
        interaction: {
          type: 'scroll',
          target: interaction.target,
          focus: false,
          only_if_not_visible: onlyIfNotVisible,
        },
      })
    }

    const nestedFlow = Array.isArray(step?.flow) ? step.flow : null
    const nestedElseFlow = Array.isArray(step?.elseFlow) ? step.elseFlow : null
    if (nestedFlow && nestedFlow.length > 0) {
      const nextStep = {
        ...step,
        flow: injectAutoScrollSteps(nestedFlow, options, currentPath),
      }
      if (nestedElseFlow && nestedElseFlow.length > 0) {
        nextStep.elseFlow = injectAutoScrollSteps(nestedElseFlow, options, currentPath)
      }
      injected.push(nextStep)
    } else if (nestedElseFlow && nestedElseFlow.length > 0) {
      injected.push({
        ...step,
        elseFlow: injectAutoScrollSteps(nestedElseFlow, options, currentPath),
      })
    } else {
      injected.push(step)
    }
  }

  return injected
}

async function scenarioLogTargetAvailability(page, step, stepRuntime) {
  const interaction = step?.interaction || {}
  const target = interaction.target || {}
  const interactionType = String(interaction.type || '').trim().toLowerCase()
  const genericSelector = scenarioBuildGenericTargetSelector(target)
  const supportedInteractionTypes = new Set(['click', 'fill', 'append', 'replace', 'select', 'upload', 'scroll', 'assert', 'search-and-select'])

  if (!supportedInteractionTypes.has(interactionType) || Object.keys(target || {}).length === 0) {
    return
  }

  if (target.url && Object.keys(target).every((key) => key === 'url' || key === 'state')) {
    return
  }

  const availabilityOptions = {}
  if (genericSelector) {
    availabilityOptions.genericSelector = genericSelector
  }

  if (interactionType === 'fill' || interactionType === 'append' || interactionType === 'replace' || interactionType === 'upload') {
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      availabilityOptions.textMode = 'label'
      availabilityOptions.preferredControl = 'fill'
    }
  } else if (interactionType === 'select') {
    if (scenarioTargetNeedsRuntimeLocator(target) || target['data-id'] || target.label || target['aria-label']) {
      availabilityOptions.textMode = 'label'
      availabilityOptions.preferredControl = 'select'
    }
  } else if (interactionType === 'scroll') {
    if (scenarioTargetNeedsRuntimeLocator(target) && !target.role) {
      availabilityOptions.textMode = 'label'
    }
  }

  const availability = await describeTargetAvailability(page, target, availabilityOptions)
    .catch((error) => ({
      count: 0,
      strategy: 'unresolved',
      selectors: [],
      error: String(error && error.message ? error.message : error),
    }))

  await stepRuntime.log('info', 'target-availability', {
    interactionType,
    availableCount: availability.count,
    selectorStrategy: availability.strategy,
    selectors: availability.selectors,
    preferredControl: availability.preferredControl ?? null,
    textMode: availability.textMode ?? null,
    targetIndex: availability.targetIndex ?? null,
    error: availability.error ?? null,
  })
}

async function assertExpectedScenarioResults(page, expectedResults = []) {
  for (const rawResult of expectedResults || []) {
    const result = rawResult || {}
    const target = result.target || {}
    const state = result.state || target.state || {}

    if (target.url) {
      await page.waitForURL(String(target.url))
      continue
    }

    let locator = null
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      locator = await resolveTargetLocator(page, target, { textMode: 'text' })
    } else if (target.testid) {
      locator = await pickIndexedLocator(buildTestIdLocator(page, target.testid, target), target)
    } else if (target.text) {
      locator = target.role
        ? await pickIndexedLocator(page.getByRole(String(target.role), { name: String(target.text), exact: true }), target)
        : await pickIndexedLocator(page.getByText(String(target.text), { exact: true }), target)
    } else if (scenarioBuildGenericTargetSelector(target)) {
      locator = await pickIndexedLocator(page.locator(scenarioBuildGenericTargetSelector(target)), target)
    } else if (target.id) {
      locator = await pickIndexedLocator(page.locator(`[id=${JSON.stringify(String(target.id))}]`), target)
    } else if (target['data-id']) {
      locator = await pickIndexedLocator(page.locator(`[data-id=${JSON.stringify(String(target['data-id']))}]`), target)
    }

    if (!locator) {
      continue
    }

    if (state.visible === true) {
      await locator.waitFor({ state: 'visible' })
    }
    if (state.visible === false) {
      await locator.waitFor({ state: 'hidden' })
    }
    if (state['value-present'] === true) {
      const value = await readComparableValue(locator)
      if (value == null || value.length === 0) {
        throw new Error('Expected a non-empty value.')
      }
    }
    if (state['value-present'] === false) {
      const value = await readComparableValue(locator)
      if (value != null && value.length > 0) {
        throw new Error('Expected an empty value.')
      }
    }
  }
}

export function prepareScenarioFlow(flowEntries, options = {}) {
  return injectAutoScrollSteps(flowEntries, { enabled: options.autoScroll !== false })
}

export function createScenarioExecutionState({
  page,
  testInfo = null,
  runtimeVariables = {},
  initialRuntimeVariables = {},
  smoothScrollEnabled = false,
  scrollDelayMs = 35,
} = {}) {
  const state = {
    page,
    testInfo,
    runtimeVariables: cloneRuntimeVariables(runtimeVariables),
    smoothScrollEnabled: Boolean(smoothScrollEnabled),
    scrollDelayMs: Math.max(0, Number(scrollDelayMs ?? 35) || 35),
    lastDownload: null,
    lastPdfResponse: null,
  }

  seedRuntimeVariables(state.runtimeVariables, initialRuntimeVariables)

  if (page?.on) {
    page.on('download', (download) => {
      state.lastDownload = download
    })
    page.on('response', (response) => {
      if (String(response.headers()['content-type'] || '').includes('application/pdf')) {
        state.lastPdfResponse = response
      }
    })
  }

  return state
}

export function describeScenarioStep(step) {
  return scenarioBuildStepDescription(step)
}

export function buildScenarioStepMeta(step) {
  return scenarioBuildStepMeta(step)
}

export async function executeScenarioStep(context, step, runtimeOptions = {}) {
  const page = context?.page
  const stepRuntime = runtimeOptions?.stepRuntime
  const interaction = step?.interaction || {}
  const interactionType = String(interaction.type || '').trim().toLowerCase()
  const target = interaction.target || {}
  const runtimeVariables = context?.runtimeVariables || {}
  const scrollDelayMs = context?.scrollDelayMs ?? 35
  const smoothScrollEnabled = context?.smoothScrollEnabled === true

  if (!page) {
    throw new Error('executeScenarioStep requires a Playwright page in context.page.')
  }

  if (!interactionType) {
    return { __scenarioStepStatus: 'noop' }
  }

  if (stepRuntime) {
    await scenarioLogTargetAvailability(page, step, stepRuntime)
  }

  const writeClickedElementToStep = (clickResult) => {
    if (clickResult?.clickedElement) {
      stepRuntime?.setStepDetail?.('clickedElement', clickResult.clickedElement)
    }
    if (clickResult?.clickPoint) {
      stepRuntime?.setStepDetail?.('clickPoint', clickResult.clickPoint)
    }
    if (Number.isFinite(Number(clickResult?.clickedAtMs))) {
      stepRuntime?.setStepDetail?.('clickedAtMs', Math.max(0, Math.round(Number(clickResult.clickedAtMs))))
    }
  }

  const writeFillPointToStep = (fillResult) => {
    if (fillResult?.fillPoint) {
      stepRuntime?.setStepDetail?.('fillPoint', fillResult.fillPoint)
    }
  }

  if (interactionType === 'open') {
    if (!target.url) {
      throw new Error(`Step "${step.id}" has interaction type "open" but no target.url.`)
    }
    await page.goto(resolveRuntimeTemplateString(String(target.url), runtimeVariables), { waitUntil: 'networkidle' })
  } else if (interactionType === 'fill') {
    const resolvedValue = resolveRuntimeTemplateString(String(interaction.value || ''), runtimeVariables)
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      const locator = await resolveTargetLocator(page, target, { textMode: 'label', preferredControl: 'fill' })
      writeFillPointToStep(
        await applyFillValueToLocator(page, locator, resolvedValue, { targetLabel: scenarioBuildScrollTargetSummary(target) || '<target>' }, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true }),
      )
    } else if (target.testid) {
      writeFillPointToStep(
        await applyFillValue(page, String(target.testid), resolvedValue, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else if (target.text) {
      await pickIndexedLocator(page.getByLabel(resolveRuntimeTemplateString(String(target.text), runtimeVariables), { exact: true }), target).then((locator) => locator.fill(resolvedValue))
    } else if (scenarioBuildGenericTargetSelector(target)) {
      await pickIndexedLocator(page.locator(resolveRuntimeTemplateString(scenarioBuildGenericTargetSelector(target), runtimeVariables)), target).then((locator) => locator.fill(resolvedValue))
    } else if (target.id || target['data-id']) {
      writeFillPointToStep(
        await applyFillValueById(page, String(target['data-id'] || target.id), resolvedValue, target['data-id'] ? 'data-id' : 'id', { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else {
      throw new Error(`Step "${step.id}" has interaction type "fill" but no supported target.`)
    }
  } else if (interactionType === 'append') {
    const resolvedValue = resolveRuntimeTemplateString(String(interaction.value || ''), runtimeVariables)
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      const locator = await resolveTargetLocator(page, target, { textMode: 'label', preferredControl: 'fill' })
      writeFillPointToStep(
        await applyAppendValueToLocator(page, locator, resolvedValue, { targetLabel: scenarioBuildScrollTargetSummary(target) || '<target>' }, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true }),
      )
    } else if (target.testid) {
      writeFillPointToStep(
        await applyAppendValue(page, String(target.testid), resolvedValue, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else if (target.id || target['data-id']) {
      writeFillPointToStep(
        await applyAppendValueById(page, String(target['data-id'] || target.id), resolvedValue, target['data-id'] ? 'data-id' : 'id', { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else {
      throw new Error(`Step "${step.id}" has interaction type "append" but no supported target.`)
    }
  } else if (interactionType === 'replace') {
    const resolvedSearch = resolveRuntimeTemplateString(String(interaction.searchValue || ''), runtimeVariables)
    const resolvedValue = resolveRuntimeTemplateString(String(interaction.value || ''), runtimeVariables)
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      const locator = await resolveTargetLocator(page, target, { textMode: 'label', preferredControl: 'fill' })
      writeFillPointToStep(
        await applyReplaceValueToLocator(page, locator, resolvedSearch, resolvedValue, { targetLabel: scenarioBuildScrollTargetSummary(target) || '<target>' }, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true }),
      )
    } else if (target.testid) {
      writeFillPointToStep(
        await applyReplaceValue(page, String(target.testid), resolvedSearch, resolvedValue, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else if (target.id || target['data-id']) {
      writeFillPointToStep(
        await applyReplaceValueById(page, String(target['data-id'] || target.id), resolvedSearch, resolvedValue, target['data-id'] ? 'data-id' : 'id', { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else {
      throw new Error(`Step "${step.id}" has interaction type "replace" but no supported target.`)
    }
  } else if (interactionType === 'click') {
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      const locator = await resolveTargetLocator(page, target, { textMode: 'text' })
      if (target.click_child_selector) {
        writeClickedElementToStep(
          await applyClickValueToLocator(
            page,
            locator.locator(String(target.click_child_selector)).first(),
            { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true },
            { targetLabel: `${scenarioBuildScrollTargetSummary(target) || '<target>'} -> ${String(target.click_child_selector)}` },
          ),
        )
      } else {
        writeClickedElementToStep(
          await applyClickValueToLocator(page, locator, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true }, { targetLabel: scenarioBuildScrollTargetSummary(target) || '<target>' }),
        )
      }
    } else if (target.text) {
      const locator = target.role
        ? await pickIndexedLocator(page.getByRole(String(target.role), { name: String(target.text), exact: true }), target)
        : await pickIndexedLocator(page.getByText(String(target.text), { exact: true }), target)
      if (target.click_child_selector) {
        writeClickedElementToStep(
          await applyClickValueToLocator(
            page,
            locator.locator(String(target.click_child_selector)).first(),
            { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true },
            { targetLabel: `${scenarioBuildScrollTargetSummary(target) || '<target>'} -> ${String(target.click_child_selector)}` },
          ),
        )
      } else {
        writeClickedElementToStep(
          await applyClickValueToLocator(page, locator, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true }, { targetLabel: scenarioBuildScrollTargetSummary(target) || '<target>' }),
        )
      }
    } else if (target.testid) {
      const locator = await pickIndexedLocator(page.getByTestId(String(target.testid)), target)
      writeClickedElementToStep(
        await applyClickValueToLocator(page, locator, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true }, { targetLabel: scenarioBuildScrollTargetSummary(target) || '<target>' }),
      )
    } else if (scenarioBuildGenericTargetSelector(target)) {
      writeClickedElementToStep(
        await applyClickValueBySelector(page, scenarioBuildGenericTargetSelector(target), { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else if (target.id || target['data-id']) {
      writeClickedElementToStep(
        await applyClickValueById(page, String(target['data-id'] || target.id), target['data-id'] ? 'data-id' : 'id', { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] }),
      )
    } else {
      throw new Error(`Step "${step.id}" has interaction type "click" but no supported target.`)
    }
  } else if (interactionType === 'select') {
    const resolvedValue = resolveRuntimeTemplateString(String(interaction.value || ''), runtimeVariables)
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      const locator = await resolveTargetLocator(page, target, { textMode: 'label', preferredControl: 'select' })
      await applySelectValueToLocator(page, locator, resolvedValue, { targetLabel: scenarioBuildScrollTargetSummary(target) || '<target>' }, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true })
    } else if (target.testid) {
      await applySelectValue(page, String(target.testid), resolvedValue, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] })
    } else if (target.id || target['data-id']) {
      await applySelectValueById(page, String(target['data-id'] || target.id), resolvedValue, target['data-id'] ? 'data-id' : 'id', { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] })
    } else {
      throw new Error(`Step "${step.id}" has interaction type "select" but no supported target.`)
    }
  } else if (interactionType === 'upload') {
    const resolvedFile = interaction.temp === true
      ? {
          temp: true,
          filename: resolveRuntimeTemplateString(String(interaction.filename || ''), runtimeVariables),
          content: resolveRuntimeTemplateString(String(interaction.value || ''), runtimeVariables),
        }
      : resolveRuntimeTemplateString(String(interaction.value || ''), runtimeVariables)
    if (scenarioTargetNeedsRuntimeLocator(target)) {
      const locator = await resolveTargetLocator(page, target, { textMode: 'label' })
      await applyUploadValueToLocator(page, locator, resolvedFile, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true })
    } else if (target.testid) {
      await applyUploadValue(page, String(target.testid), resolvedFile, { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] })
    } else if (scenarioBuildGenericTargetSelector(target)) {
      await applyUploadValueById(page, scenarioBuildGenericTargetSelector(target), resolvedFile, 'selector', { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] })
    } else if (target.id || target['data-id']) {
      await applyUploadValueById(page, String(target['data-id'] || target.id), resolvedFile, target['data-id'] ? 'data-id' : 'id', { smoothScroll: smoothScrollEnabled, stepDelayMs: scrollDelayMs, skipAutoScroll: true, targetIndex: target['treffer-index'] })
    } else {
      throw new Error(`Step "${step.id}" has interaction type "upload" but no supported target.`)
    }
  } else if (interactionType === 'scroll') {
    if (!scenarioHasUsableScrollTarget(target)) {
      throw new Error(`Step "${step.id}" has interaction type "scroll" but no supported target.`)
    }
    const locator = scenarioTargetNeedsRuntimeLocator(target)
      ? await resolveTargetLocator(page, target, { textMode: target.role ? 'text' : 'label' })
      : target.text
        ? (target.role ? await pickIndexedLocator(page.getByRole(String(target.role), { name: String(target.text), exact: true }), target) : await pickIndexedLocator(page.getByText(String(target.text), { exact: true }), target))
        : target.testid
          ? await pickIndexedLocator(page.getByTestId(String(target.testid)), target)
          : scenarioBuildGenericTargetSelector(target)
            ? await pickIndexedLocator(page.locator(scenarioBuildGenericTargetSelector(target)), target)
            : await pickIndexedLocator(page.locator(target['data-id'] ? `[data-id=${JSON.stringify(String(target['data-id']))}]` : `[id=${JSON.stringify(String(target.id))}]`), target)
    const scrollResult = await scrollToLocator(page, locator, {
      stepDelayMs: scrollDelayMs,
      focus: interaction.focus === true,
      onlyIfNotVisible: interaction.only_if_not_visible === true,
    })
    if (scrollResult.direction) {
      stepRuntime?.setStepDetail?.('scrollDirection', scrollResult.direction)
    }
    if (!scrollResult.didScroll) {
      return { __scenarioStepStatus: 'noop', reason: 'target already visible' }
    }
  } else if (interactionType === 'wait') {
    const durationCandidate = interaction.ms ?? interaction.timeout_ms ?? null
    if (durationCandidate != null) {
      const durationMs = Number(durationCandidate)
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(`Step "${step.id}" has invalid wait duration.`)
      }
      await page.waitForTimeout(Math.floor(durationMs))
    }
    if (interaction.until) {
      await waitForCondition(page, interaction.until, Math.floor(Number(interaction.timeout_ms ?? 5000) || 5000), Math.max(25, Math.floor(Number(interaction.poll_ms ?? 100) || 100)))
    } else if (interaction.target && interaction.state) {
      await waitForCondition(page, { target: interaction.target, state: interaction.state }, Math.floor(Number(interaction.timeout_ms ?? 5000) || 5000), Math.max(25, Math.floor(Number(interaction.poll_ms ?? 100) || 100)))
    } else if (durationCandidate == null) {
      throw new Error(`Step "${step.id}" has interaction type "wait" but no waiting criteria.`)
    }
  } else if (interactionType === 'assert') {
    if (target.url) {
      await page.waitForURL(String(interaction.value ?? target.url))
    } else {
      const expectedValue = String(interaction.value ?? '')
      if (scenarioTargetNeedsRuntimeLocator(target)) {
        const locator = await resolveTargetLocator(page, target, { textMode: 'label' })
        await assertElementValueByLocator(locator, expectedValue, scenarioBuildScrollTargetSummary(target) || '<target>')
      } else if (target.testid) {
        await assertElementValueByTestId(page, String(target.testid), expectedValue, { targetIndex: target['treffer-index'] })
      } else if (target.id || target['data-id']) {
        await assertElementValueById(page, String(target['data-id'] || target.id), expectedValue, target['data-id'] ? 'data-id' : 'id', { targetIndex: target['treffer-index'] })
      } else {
        throw new Error(`Step "${step.id}" has interaction type "assert" but no supported target.`)
      }
    }
  } else if (interactionType === 'search-and-select') {
    await searchAndSelect(page, {
      target: { 'data-id': String(target['data-id']) },
      value: String(interaction.value),
      resultSelector: String(interaction.resultSelector),
      resultIndex: interaction.resultIndex != null ? Number(interaction.resultIndex) : 0,
      smoothScroll: smoothScrollEnabled,
      stepDelayMs: scrollDelayMs,
      skipAutoScroll: true,
    })
    if (interaction.assert) {
      await assertExpectedScenarioResults(page, [interaction.assert])
    }
  } else if (interactionType === 'extract-pdf-code') {
    const regex = resolveRuntimeTemplateString(String(interaction.auslesenRegex || ''), runtimeVariables)
    const output = String(interaction.output || 'extractedCode')
    const pdfPath = interaction.pdfPath
      ? resolveRuntimeTemplateString(String(interaction.pdfPath), runtimeVariables)
      : context?.testInfo?.outputPath?.(`${String(step.id || 'extract-pdf')}.pdf`)
    const extractedValue = await extractCodeFromPdf(pdfPath, new RegExp(regex), {
      download: context?.lastDownload ?? null,
      response: context?.lastPdfResponse ?? null,
    })
    setRuntimeVariable(runtimeVariables, output, extractedValue)
  } else if (interactionType === 'read-ui-value') {
    const output = String(interaction.output || '').trim()
    if (!output) {
      throw new Error(`Step "${step.id}" with type read-ui-value requires output.`)
    }
    if (String(interaction.source || 'text').trim().toLowerCase() === 'url') {
      setRuntimeVariable(runtimeVariables, output, page.url())
    } else {
      const locator = await resolveTargetLocator(page, target, { textMode: 'text' })
      const source = String(interaction.source || 'text').trim().toLowerCase()
      const value = await locator.evaluate((element, payload) => {
        const sourceType = String(payload.source || 'text')
        const tagName = String(element?.tagName || '').toLowerCase()
        const inputType = String(element?.getAttribute?.('type') || '').toLowerCase()
        if (sourceType === 'value') {
          return String(element?.value ?? element?.getAttribute?.('value') ?? '')
        }
        if (sourceType === 'text') {
          if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || inputType === 'text') {
            return String(element?.value ?? element?.getAttribute?.('value') ?? '')
          }
          return String(element?.innerText ?? element?.textContent ?? '').trim()
        }
        return ''
      }, { source })
      setRuntimeVariable(runtimeVariables, output, value)
    }
  } else if (interactionType === 'read-pin-brief-mail') {
    const activationCode = await readActivationCodeFromMailhog({
      mailhogUrl: resolveRuntimeTemplateString(String(interaction.url || ''), runtimeVariables),
      vornamen: interaction.vornamen ? resolveRuntimeTemplateString(String(interaction.vornamen), runtimeVariables) : '',
      familienname: interaction.familienname ? resolveRuntimeTemplateString(String(interaction.familienname), runtimeVariables) : '',
      zeilenIndex: interaction.zeilenIndex == null ? null : Number(interaction.zeilenIndex),
    })
    setRuntimeVariable(runtimeVariables, String(interaction.output || ''), activationCode)
  } else if (interactionType === 'api-request') {
    const apiResponse = await executeScenarioApiRequest({
      method: String(interaction.method || '').trim().toUpperCase(),
      url: resolveRuntimeTemplateString(String(interaction.url || ''), runtimeVariables),
      payloadTemplate: String(interaction.payload ?? ''),
      runtimeVariables,
    })
    for (const read of Array.isArray(interaction.reads) ? interaction.reads : []) {
      const value = readScenarioApiResponseValue(apiResponse, String(read?.parameter ?? ''), resolveRuntimeTemplateString(String(read?.regex ?? ''), runtimeVariables))
      setRuntimeVariable(runtimeVariables, String(read?.output || ''), value)
    }
  } else if (interactionType === 'set-runtime-variable') {
    setRuntimeVariable(runtimeVariables, String(interaction.output || ''), resolveRuntimeTemplateString(String(interaction.value ?? ''), runtimeVariables))
  } else {
    throw new Error(`Unsupported interaction type "${interactionType}" in step "${step.id}".`)
  }

  if (Array.isArray(step?.expected_results) && step.expected_results.length > 0) {
    await assertExpectedScenarioResults(page, step.expected_results)
  }

  return { __scenarioStepStatus: 'executed' }
}

export async function runPreparedScenarioFlow({
  steps,
  executionRuntime,
  executionState,
  stepIdentifierLogger = null,
} = {}) {
  for (const step of steps || []) {
    const stepId = typeof step?.resolvedId === 'string' ? step.resolvedId.trim() : String(step?.id || '').trim()
    const stepDescription = scenarioBuildStepDescription(step)
    const stepMeta = scenarioBuildStepMeta(step)
    const conditionalCondition = step?.condition && typeof step.condition === 'object' ? step.condition : null
    const conditionalThenFlow = Array.isArray(step?.flow) ? step.flow : []
    const conditionalElseFlow = Array.isArray(step?.elseFlow) ? step.elseFlow : []
    const isConditionalBranchStep = Boolean(conditionalCondition && (conditionalThenFlow.length > 0 || conditionalElseFlow.length > 0))
    const ifConditions = scenarioToConditionList(step?.if, 'if', stepId)
    const ifNotConditions = scenarioToConditionList(step?.ifnot, 'ifnot', stepId)

    await executionRuntime.runStep(stepId, stepDescription, async (stepRuntime) => {
      if (stepIdentifierLogger?.capture) {
        await stepIdentifierLogger.capture(stepId, 'before')
      }

      if (isConditionalBranchStep) {
        const conditionMet = await shouldRunStepFromGuards(executionState.page, { if: [conditionalCondition], ifnot: [] })
        if (conditionMet) {
          if (conditionalThenFlow.length > 0) {
            await runPreparedScenarioFlow({
              steps: conditionalThenFlow,
              executionRuntime,
              executionState,
              stepIdentifierLogger,
            })
            if (stepIdentifierLogger?.capture) {
              await stepIdentifierLogger.capture(stepId, 'after')
            }
            return { __scenarioStepStatus: 'executed' }
          }
          if (stepIdentifierLogger?.capture) {
            await stepIdentifierLogger.capture(stepId, 'skipped', { reason: 'conditional then-branch empty' })
          }
          return { __scenarioStepStatus: 'skipped', reason: 'conditional then-branch empty' }
        }

        if (conditionalElseFlow.length > 0) {
          await runPreparedScenarioFlow({
            steps: conditionalElseFlow,
            executionRuntime,
            executionState,
            stepIdentifierLogger,
          })
          if (stepIdentifierLogger?.capture) {
            await stepIdentifierLogger.capture(stepId, 'after')
          }
          return { __scenarioStepStatus: 'executed' }
        }

        if (stepIdentifierLogger?.capture) {
          await stepIdentifierLogger.capture(stepId, 'skipped', { reason: 'condition not met and no else branch' })
        }
        return { __scenarioStepStatus: 'skipped', reason: 'condition not met and no else branch' }
      }

      if (ifConditions.length > 0 || ifNotConditions.length > 0) {
        const shouldRunStep = await shouldRunStepFromGuards(executionState.page, { if: ifConditions, ifnot: ifNotConditions })
        if (!shouldRunStep) {
          if (stepIdentifierLogger?.capture) {
            await stepIdentifierLogger.capture(stepId, 'skipped', { reason: 'if/ifnot guard condition not met' })
          }
          return { __scenarioStepStatus: 'skipped', reason: 'if/ifnot guard condition not met' }
        }
      }

      const nestedFlow = Array.isArray(step?.flow) ? step.flow : []
      if (nestedFlow.length > 0 && !step?.interaction) {
        await runPreparedScenarioFlow({
          steps: nestedFlow,
          executionRuntime,
          executionState,
          stepIdentifierLogger,
        })
      } else {
        await executeScenarioStep(executionState, step, { stepRuntime })
      }

      const runtimeVariablesSnapshot = cloneRuntimeVariables(executionState?.runtimeVariables || {})
      stepRuntime?.info?.('runtime-variables', runtimeVariablesSnapshot)

      if (stepIdentifierLogger?.capture) {
        await stepIdentifierLogger.capture(stepId, 'after')
      }

      return { __scenarioStepStatus: 'executed' }
    }, stepMeta)
  }
}
