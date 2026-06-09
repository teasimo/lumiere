#!/usr/bin/env node
/**
 * Debug-Script: Parst eine SzenarioScript-XML zu JSON und legt
 * das Ergebnis unter output/[szenario-id]/szenario.json ab.
 *
 * Aufruf:
 *   node scripts/debug-parse-scenario.mjs <pfad/zur/szenario.xml>
 */

import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, join, basename } from 'path'
import { fileURLToPath } from 'url'
import { parseScenarioXml } from './shared/parse-scenario-xml.mjs'

const __dirname = join(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(__dirname, '..')
const OUTPUT_ROOT = join(REPO_ROOT, 'output')

const argv = process.argv.slice(2)
const wantsHelp = argv.includes('--help') || argv.includes('-h')
const xmlPathArg = argv.find((a) => !a.startsWith('-'))

if (!xmlPathArg || wantsHelp) {
  console.log('Aufruf: node scripts/debug-parse-scenario.mjs <szenario.xml>')
  process.exit(wantsHelp ? 0 : 1)
}

const absXmlPath = resolve(xmlPathArg)
if (!existsSync(absXmlPath)) {
  console.error(`Fehler: Datei nicht gefunden: ${xmlPathArg}`)
  process.exit(1)
}

console.log(`Verarbeite: ${xmlPathArg}`)

const result = parseScenarioXml(absXmlPath)

if (!result.valid) {
  console.error('XSD-Validierung fehlgeschlagen:')
  console.error(result.errors)
  process.exit(1)
}

// Szenario-ID aus dem root-Element ermitteln
const scenarioId =
  result.tree?._attrs?.id ||
  basename(xmlPathArg).replace(/\.[^.]+$/, '')

const outputDir = join(OUTPUT_ROOT, scenarioId)
await mkdir(outputDir, { recursive: true })

const outputPath = join(outputDir, 'szenario.json')
await writeFile(outputPath, JSON.stringify(result.tree, null, 2), 'utf8')

console.log(`Ausgabe: ${outputPath}`)
