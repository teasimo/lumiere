#!/usr/bin/env node

import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { spawnSync } from 'child_process'

const OUTPUT_ROOT = resolve('output')

function sanitizeFileToken(value) {
  return String(value || 'output')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'output'
}

function sanitizeScenarioVersionForFolder(value) {
  let normalized = value

  if (typeof normalized === 'number' && Number.isFinite(normalized)) {
    if (Number.isInteger(normalized)) {
      normalized = `${normalized}.0`
    } else {
      normalized = String(normalized)
    }
  }

  return String(normalized || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/\./g, '_')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

function buildScenarioOutputFolderName({ scenarioId, scenarioVersion }) {
  const idToken = sanitizeFileToken(scenarioId || 'scenario')
  const versionToken = sanitizeScenarioVersionForFolder(scenarioVersion || 'unknown')
  return `${idToken}_v${versionToken}`
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.error) {
    throw result.error
  }

  return Number(result.status ?? 1)
}

async function findLatestRemotionMuxMeta(ttsDir, { allowPlanOnly = false } = {}) {
  if (!existsSync(ttsDir)) {
    return null
  }

  const entries = await readdir(ttsDir)
  const candidates = []
  for (const entry of entries) {
    if (!/^scenario-tts-remotion-render-.*\.json$/i.test(entry)) {
      continue
    }
    const filePath = join(ttsDir, entry)
    const fileStat = await stat(filePath)
    let isPlanOnly = false
    try {
      const metaRaw = await readFile(filePath, 'utf8')
      isPlanOnly = JSON.parse(metaRaw)?.planOnly === true
    } catch { /* ignore */ }
    candidates.push({
      filePath,
      mtimeMs: fileStat.mtimeMs,
      isPlanOnly,
    })
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const fullRunCandidates = candidates.filter((c) => !c.isPlanOnly)
  if (fullRunCandidates.length > 0) return fullRunCandidates[0]
  if (allowPlanOnly) return candidates[0] || null
  return null
}

async function main() {
  const argv = process.argv.slice(2)
  const keepTempProject = argv.includes('--keep-temp-project')
  const verbose = argv.includes('--verbose')
  const scenarioPathArg = argv.find((arg) => !arg.startsWith('-'))
  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  if (!scenarioPathArg || wantsHelp) {
    console.log('Usage: node scripts/video-script-generator/remotion-render.mjs <scenario.xml> [--keep-temp-project]')
    process.exit(wantsHelp ? 0 : 1)
  }

  const scenarioAbsolutePath = resolve(scenarioPathArg)
  if (!existsSync(scenarioAbsolutePath)) {
    throw new Error(`Szenario-Datei nicht gefunden: ${scenarioPathArg}`)
  }

  const scenarioRaw = await readFile(scenarioAbsolutePath, 'utf8')
  const idMatch = scenarioRaw.match(/<SzenarioScript\b[^>]*\bid\s*=\s*"([^"]+)"/i)
  const versionMatch = scenarioRaw.match(/<SzenarioScript\b[^>]*\bszenario-version\s*=\s*"([^"]+)"/i)
  const scenarioRoot = {
    id: idMatch?.[1] || null,
    version: versionMatch?.[1] || null,
  }

  const scenarioToken = sanitizeFileToken(basename(scenarioPathArg).replace(/\.[^.]+$/, ''))
  const scenarioFolderName = buildScenarioOutputFolderName({
    scenarioId: scenarioRoot.id || scenarioToken,
    scenarioVersion: scenarioRoot.version || 'unknown',
  })

  const ttsOutputDir = join(OUTPUT_ROOT, scenarioFolderName, 'tts')
  const latestMeta = await findLatestRemotionMuxMeta(ttsOutputDir)

  if (!latestMeta) {
    throw new Error([
      `Keine vollstaendige Remotion-Render-Metadatei unter ${ttsOutputDir} gefunden.`,
      'Bitte zuerst den vollen Pipeline-Lauf ausfuehren (ohne --remotion-plan-only), um TTS zu synthetisieren.',
    ].join(' '))
  }

  const metaRaw = await readFile(latestMeta.filePath, 'utf8')
  const meta = JSON.parse(metaRaw)
  const planPath = String(meta?.renderPlanPath || '').trim()
  if (!planPath || !existsSync(planPath)) {
    throw new Error(`Render-Plan nicht gefunden (aus ${latestMeta.filePath}): ${planPath || '<leer>'}`)
  }

  const renderTsxPath = String(meta?.renderTsxPath || '').trim()
  if (!renderTsxPath || !existsSync(renderTsxPath)) {
    throw new Error([
      `TSX-Composition fehlt oder existiert nicht (aus ${latestMeta.filePath}): ${renderTsxPath || '<leer>'}`,
      'Das Render-Script verlangt jetzt immer --tsx mit gueltigem Pfad.',
    ].join(' '))
  }

  const muxArgs = [
    'scripts/video-script-generator/remotion-mux-video-tts.mjs',
    `--plan=${planPath}`,
    `--tsx=${renderTsxPath}`,
  ]
  if (keepTempProject) {
    muxArgs.push('--keep-temp-project')
  }
  if (verbose) {
    muxArgs.push('--verbose')
  }

  const exitCode = runCommand('node', muxArgs)
  if (exitCode !== 0) {
    throw new Error(`Remotion-Render fehlgeschlagen (Exit-Code ${exitCode}).`)
  }

  if (renderTsxPath) {
    console.log(`Remotion-TSX: ${renderTsxPath}`)
  }
  console.log(`Gerendert mit Render-Plan: ${planPath}`)
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exit(1)
})
