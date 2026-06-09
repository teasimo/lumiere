import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve, relative } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { XMLParser } from 'fast-xml-parser'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')

const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'szenarioscript.xsd')
const FRAGMENT_LIBRARY_PATH = join(REPO_ROOT, 'neo', 'fragements', 'fragment-library.json')

// ── XSD-Validierung ──────────────────────────────────────────────────────────

export function validateXml(xmlAbsPath, { schemaPath = SCHEMA_PATH } = {}) {
  const result = spawnSync('xmllint', ['--schema', schemaPath, '--noout', xmlAbsPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    return { valid: false, errors: (result.stderr || result.stdout || '').trim() }
  }
  return { valid: true, errors: null }
}

// ── Zeilennummern ────────────────────────────────────────────────────────────

function buildLineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function offsetToLine(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * Gibt alle öffnenden Tags in Dokumentreihenfolge zurück: [{tag, line}, ...]
 * Schließende Tags (</Tag>) werden ignoriert, da < direkt von / gefolgt wird.
 */
function extractOpeningTagPositions(rawXml, lineStarts) {
  // Stimmt auf <TagName ...> und <TagName .../> ab, aber nicht auf </TagName>
  const re = /<([A-Za-z][A-Za-z0-9_:-]*)(?:\s[^>]*)?\/?>/g
  const positions = []
  let m
  while ((m = re.exec(rawXml)) !== null) {
    positions.push({ tag: m[1], line: offsetToLine(lineStarts, m.index) })
  }
  return positions
}

// ── Fragment-Bibliothek ──────────────────────────────────────────────────────

function loadFragmentLibrary() {
  if (!existsSync(FRAGMENT_LIBRARY_PATH)) return {}
  return JSON.parse(readFileSync(FRAGMENT_LIBRARY_PATH, 'utf8'))
}

function chooseFragmentPath(fragmentName, fragmentLibrary) {
  const normalizedName = String(fragmentName || '').trim()
  if (!normalizedName) {
    return null
  }

  if (fragmentLibrary[normalizedName]) {
    return fragmentLibrary[normalizedName]
  }

  const suffix = normalizedName.includes('-')
    ? normalizedName.split('-').filter(Boolean).slice(-1)[0]
    : ''

  if (!suffix) {
    return null
  }

  const suffixCandidates = Object.entries(fragmentLibrary)
    .filter(([fragmentId]) => fragmentId === suffix)
    .map(([, fragmentPath]) => fragmentPath)
    .sort((left, right) => left.localeCompare(right))

  return suffixCandidates[0] || null
}

// ── XML-Parser ───────────────────────────────────────────────────────────────

const PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
})

const RESOLVED_ID_RELEVANT_TAGS = new Set([
  'Click',
  'Eingabe',
  'Auswahl',
  'Upload',
  'Anzeige',
  'Warten',
  'Oeffnen',
  'SucheAuswahl',
])

function parseRawXml(rawXml) {
  return PARSER.parse(rawXml)
}

function isTestRelevantStep(node) {
  return Boolean(node && typeof node === 'object' && RESOLVED_ID_RELEVANT_TAGS.has(String(node._tag || '').trim()))
}

export function addTeststepNumber(json) {
  let sequence = 0

  function visit(node) {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry)
      }
      return
    }

    if (isTestRelevantStep(node)) {
      sequence += 1
      node['teststep-number'] = sequence
    }

    if (Array.isArray(node._children)) {
      visit(node._children)
    }

    if (Array.isArray(node._resolved)) {
      visit(node._resolved)
    }
  }

  visit(json)
  return json
}

// ── Kern-Transformation ──────────────────────────────────────────────────────

/**
 * Durchläuft den geordneten Knotenbaum (preserveOrder:true) in Dokumentreihenfolge
 * und baut eine normalisierte JSON-Struktur mit row-index auf.
 *
 * parentRowIndex: null  →  im Haupt-Dokument, row-index = Zeilennummer
 * parentRowIndex: "63"  →  im Fragment, das in Zeile 63 eingebunden wurde,
 *                          row-index = "63.{lokalZeile}"
 *
 * Der Cursor ist ein geteiltes Objekt { idx }, das über alle Rekursionen
 * für EINE XML-Datei vorwärts wandert – so wird jede Tag-Position genau einmal
 * verbraucht, in der Reihenfolge, in der die Tags im Dokument erscheinen.
 */
function walkNodes(orderedNodes, tagPositions, cursor, opts) {
  const { parentRowIndex, sourceFile, fragmentLibrary, visitedPaths } = opts
  const result = []

  for (const node of orderedNodes) {
    // Reine Text-Knoten werden vom Eltern-Element als _text erfasst
    if (Object.prototype.hasOwnProperty.call(node, '#text')) continue

    const tagName = Object.keys(node).find((k) => k !== ':@')
    // XML-Deklaration (?xml) und ähnliches überspringen
    if (!tagName || tagName.startsWith('?')) continue

    const rawAttrs = node[':@'] || {}
    const children = Array.isArray(node[tagName]) ? node[tagName] : []

    // Cursor bis zum nächsten Treffer für diesen Tag-Namen vorschieben
    while (cursor.idx < tagPositions.length && tagPositions[cursor.idx].tag !== tagName) {
      cursor.idx++
    }
    const localLine = cursor.idx < tagPositions.length ? tagPositions[cursor.idx].line : -1
    cursor.idx++

    // row-index: im Haupt-Dokument = Zeilennummer, in Fragment = "parent.lokalZeile"
    const rowIndex = parentRowIndex != null ? `${parentRowIndex}.${localLine}` : localLine

    // Attribute normalisieren (führendes @_ entfernen)
    const attrs = {}
    for (const [k, v] of Object.entries(rawAttrs)) {
      attrs[k.startsWith('@_') ? k.slice(2) : k] = v
    }

    // Text-Inhalt für gemischte Elemente (z. B. <Info>, <Eingabe>)
    const textNode = children.find((c) => Object.prototype.hasOwnProperty.call(c, '#text'))
    const childElements = children.filter((c) => !Object.prototype.hasOwnProperty.call(c, '#text'))

    const entry = {
      _tag: tagName,
      '_row-index': rowIndex,
    }

    // Für Fragment-Elemente: zusätzliche lokale Zeilen-Metadaten
    if (sourceFile != null) {
      entry['_local-row-index'] = localLine
      entry['_source-file'] = sourceFile
    }

    if (Object.keys(attrs).length > 0) entry._attrs = attrs

    if (textNode !== undefined) {
      const txt = String(textNode['#text'] ?? '').trim()
      if (txt) entry._text = txt
    }

    // Kinder-Elemente rekursiv verarbeiten.
    // parentRowIndex bleibt gleich (kein tieferes Nesting innerhalb einer Datei),
    // damit alle Elemente einer Fragment-Datei "fragment-caller.lokalZeile" bekommen.
    if (childElements.length > 0) {
      entry._children = walkNodes(childElements, tagPositions, cursor, {
        parentRowIndex,
        sourceFile,
        fragmentLibrary,
        visitedPaths,
      })
    }

    // Fragment auflösen
    if (tagName === 'Fragment' && attrs.name) {
      const fragmentRelPath = chooseFragmentPath(attrs.name, fragmentLibrary)
      if (fragmentRelPath) {
        const absFragmentPath = resolve(REPO_ROOT, fragmentRelPath)
        if (existsSync(absFragmentPath) && !visitedPaths.has(absFragmentPath)) {
          const newVisited = new Set(visitedPaths)
          newVisited.add(absFragmentPath)
          entry._resolved = resolveFragmentFile(
            absFragmentPath,
            rowIndex,
            relative(REPO_ROOT, absFragmentPath),
            fragmentLibrary,
            newVisited,
          )
        } else if (visitedPaths.has(absFragmentPath)) {
          entry._resolveError = `Zirkulärer Fragment-Import: ${fragmentRelPath}`
        } else {
          entry._resolveError = `Fragment-Datei nicht gefunden: ${fragmentRelPath}`
        }
      } else {
        entry._resolveError = `Fragment nicht in Bibliothek: ${attrs.name}`
      }
    }

    result.push(entry)
  }

  return result
}

/**
 * Lädt eine Fragment-XML-Datei, parst sie und gibt die aufgelösten Kinder zurück.
 * Der parentRowIndex ist der row-index des <Fragment>-Elements im Eltern-Dokument.
 */
function resolveFragmentFile(absPath, parentRowIndex, relPath, fragmentLibrary, visitedPaths) {
  const rawXml = readFileSync(absPath, 'utf8')
  const lineStarts = buildLineStarts(rawXml)
  const tagPositions = extractOpeningTagPositions(rawXml, lineStarts)
  const ordered = parseRawXml(rawXml)
  const cursor = { idx: 0 }

  // Das Root-Element (SzenarioScript) finden und überspringen
  const rootNode = ordered.find(
    (n) =>
      !Object.prototype.hasOwnProperty.call(n, '#text') &&
      Object.keys(n).some((k) => !k.startsWith('?') && k !== ':@'),
  )
  if (!rootNode) return null

  const rootTag = Object.keys(rootNode).find((k) => k !== ':@' && !k.startsWith('?'))
  const rootChildren = Array.isArray(rootNode[rootTag]) ? rootNode[rootTag] : []

  // Cursor hinter den öffnenden Root-Tag schieben
  while (cursor.idx < tagPositions.length && tagPositions[cursor.idx].tag !== rootTag) {
    cursor.idx++
  }
  cursor.idx++

  const fragmentChildren = rootChildren.filter(
    (c) => !Object.prototype.hasOwnProperty.call(c, '#text'),
  )

  return walkNodes(fragmentChildren, tagPositions, cursor, {
    parentRowIndex,
    sourceFile: relPath,
    fragmentLibrary,
    visitedPaths,
  })
}

// ── Haupt-Export ─────────────────────────────────────────────────────────────

/**
 * Parst eine SzenarioScript-XML-Datei zu einer JSON-Baumstruktur
 * mit row-index-Annotationen und aufgelösten Fragmenten.
 *
 * Validiert zunächst gegen das XSD-Schema.
 *
 * @param {string} xmlFilePath - absoluter oder repo-relativer Pfad zur XML-Datei
 * @returns {{ valid: boolean, errors: string|null, tree: object|null }}
 */
export function parseScenarioXml(xmlFilePath) {
  const absPath = resolve(xmlFilePath)

  const validation = validateXml(absPath)
  if (!validation.valid) {
    return { valid: false, errors: validation.errors, tree: null }
  }

  const rawXml = readFileSync(absPath, 'utf8')
  const lineStarts = buildLineStarts(rawXml)
  const tagPositions = extractOpeningTagPositions(rawXml, lineStarts)
  const ordered = parseRawXml(rawXml)
  const cursor = { idx: 0 }

  const fragmentLibrary = loadFragmentLibrary()
  const visitedPaths = new Set([absPath])

  const topLevel = ordered.filter((n) => !Object.prototype.hasOwnProperty.call(n, '#text'))
  const nodes = walkNodes(topLevel, tagPositions, cursor, {
    parentRowIndex: null,
    sourceFile: null,
    fragmentLibrary,
    visitedPaths,
  })

  const tree = nodes.length === 1 ? nodes[0] : nodes
  addTeststepNumber(tree)

  return {
    valid: true,
    errors: null,
    tree,
  }
}
