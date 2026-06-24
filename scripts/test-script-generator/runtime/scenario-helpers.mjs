import { access, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { centralFillStrategies } from "./central-fill-strategies.mjs"
import { extractCodeFromPdf } from "./extract-pdf-code.mjs"
export { createScenarioTimelineRuntime } from "./generated-scenario-runtime.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')

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
        resolve(REPO_ROOT, 'neo', 'assets', requestedPath),
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
        const isScrollable = /(auto|scroll|overlay)/.test(overflowY)
        if (isScrollable && current.scrollHeight > current.clientHeight) {
          return current
        }
        current = current.parentElement
      }
      return document.scrollingElement || document.documentElement
    }

    const container = getScrollableAncestor(element)
    if (config.onlyIfNotVisible && isInViewport(element)) {
      return { reachedTarget: true, moved: false }
    }
    // Erlaubte Distanz, sodass nicht mehr gescrollt wird.
    const epsilon = 2

    let moved = false

    for (let i = 0; i < config.maxSteps; i += 1) {
      const elementRect = element.getBoundingClientRect()
      const containerRect = container === document.scrollingElement || container === document.documentElement
        ? { top: 0, height: window.innerHeight }
        : container.getBoundingClientRect()

      const elementCenter = elementRect.top + (elementRect.height / 2)
      const viewportCenter = containerRect.top + (containerRect.height / 2)
      const delta = elementCenter - viewportCenter

      if (Math.abs(delta) <= epsilon) {
        return { reachedTarget: true, moved }
      }

      const step = Math.sign(delta) * Math.min(Math.abs(delta), config.stepPx)
      if (container === document.scrollingElement || container === document.documentElement) {
        window.scrollBy(0, step)
      } else {
        container.scrollBy(0, step)
      }
      if (Math.abs(step) > 0) {
        moved = true
      }

      if (config.stepDelayMs > 0) {
        await delay(config.stepDelayMs)
      }
    }

    return { reachedTarget: false, moved }
  }, { stepDelayMs, stepPx, maxSteps, onlyIfNotVisible })

  if (!scrollResult.reachedTarget) {
    await locator.scrollIntoViewIfNeeded()
  }

  await locator.waitFor({ state: "visible" })
  if (focus) {
    await locator.focus().catch(() => {})
  }
  return { didScroll: Boolean(scrollResult.moved || !scrollResult.reachedTarget) }
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
      return
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, targetLabel)
}

export async function applyFillValueById(page, elementId, value, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  const controlLocator = await resolveFillControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)

  const elementInfo = await controlLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    isContentEditable: Boolean(el.isContentEditable),
    className: String(el.className || ""),
    modelValue: el.getAttribute("model-value"),
    role: el.getAttribute("role"),
  }))

  const expectedValue = String(value ?? "")

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({ testId: elementId, elementInfo, expectedValue })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({ page, locator: controlLocator, testId: elementId, elementInfo, expectedValue })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, `#${elementId}`)
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
      return
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, targetLabel)
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
  const uploadPath = await resolveUploadAssetPath(value)
  await fileLocator.setInputFiles(uploadPath)
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
  const uploadPath = await resolveUploadAssetPath(value)
  await fileLocator.setInputFiles(uploadPath)
}

export async function applyAppendValue(page, testId, value, options = {}) {
  const locator = await pickLocator(buildTestIdLocator(page, testId, options), options)
  return applyAppendValueToLocator(page, locator, value, { targetLabel: `data-testid="${testId}"` }, options)
}

export async function applyAppendValueToLocator(page, locator, value, meta = {}, options = {}) {
  const controlLocator = await resolveFillControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)

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
      return
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, targetLabel, "append")
}

export async function applyAppendValueById(page, elementId, value, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  const controlLocator = await resolveFillControlLocator(locator)
  await ensureLocatorScroll(page, controlLocator, options)

  const elementInfo = await controlLocator.evaluate((el) => ({
    tagName: el.tagName?.toLowerCase?.() || '',
    isContentEditable: Boolean(el.isContentEditable),
    className: String(el.className || ""),
    modelValue: el.getAttribute("model-value"),
    role: el.getAttribute("role"),
  }))

  const expectedValue = String(value ?? "")

  const envStrategies = await loadEnvFillStrategies()
  for (const strategy of envStrategies) {
    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {
      continue
    }

    const isMatch = await strategy.match({ testId: elementId, elementInfo, expectedValue, isAppend: true })
    if (!isMatch) {
      continue
    }

    const result = await strategy.run({ page, locator: controlLocator, testId: elementId, elementInfo, expectedValue, isAppend: true })
    const handled = typeof result === "object" && result !== null
      ? Boolean(result.handled)
      : Boolean(result)

    if (handled) {
      return
    }
  }

  await applyDefaultFillStrategy(page, controlLocator, expectedValue, elementInfo, `#${elementId}`, "append")
}

export async function applyClickValueById(page, elementId, selectorType = "id", options = {}) {
  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`
  const locator = await pickLocator(page.locator(selector), options)
  return applyClickValueToLocator(page, locator, options, { targetLabel: selectorType === 'data-id' ? `data-id="${elementId}"` : `id="#${elementId}"` })
}

export async function applyClickValueToLocator(page, locator, options = {}, meta = {}) {
  const elementHandle = await locator.elementHandle({ timeout: 2500 }).catch(() => null)
  if (!elementHandle) {
    await clickWithOverlayRecovery(page, locator, options)
    return
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
      return
    }
  }

  await clickWithOverlayRecovery(page, locator, options)
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
  await ensureLocatorScroll(page, locator, options)
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
