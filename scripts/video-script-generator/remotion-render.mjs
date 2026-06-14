#!/usr/bin/env node

import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { buildScenarioOutputFolderName, sanitizeScenarioOutputToken } from '../shared/scenario-output.mjs'
import { appendFragmentSourceArg, resolveFragmentSourceForScenario } from '../shared/lunettes-fragment-source.mjs'

const OUTPUT_ROOT = resolve('output')

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
  const ttsVoiceArg = argv.find((arg) => arg.startsWith('--tts-voice='))
  const profileArg = argv.find((arg) => arg.startsWith('--profile='))
  const scenarioIdArg = argv.find((arg) => arg.startsWith('--scenario-id='))
  const fragmentSourceArg = argv.find((arg) => arg.startsWith('--fragment-source='))
  const profileName = String(profileArg ? profileArg.slice('--profile='.length) : 'all-channels').trim() || 'all-channels'
  const scenarioPathArg = argv.find((arg) => !arg.startsWith('-'))
  const scenarioId = sanitizeScenarioOutputToken(scenarioIdArg ? scenarioIdArg.slice('--scenario-id='.length) : '', '')
  const fragmentSource = resolveFragmentSourceForScenario(
    fragmentSourceArg ? fragmentSourceArg.slice('--fragment-source='.length) : null,
    scenarioPathArg,
    'lunettes',
  )
  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  if (!scenarioPathArg || wantsHelp) {
    console.log('Usage: node scripts/video-script-generator/remotion-render.mjs <scenario.xml> --scenario-id=<id> [--profile=<name>] [--tts-voice=<name>] [--keep-temp-project]')
    process.exit(wantsHelp ? 0 : 1)
  }
  if (!scenarioId) {
    throw new Error('Scenario-ID fehlt. Erwartet: --scenario-id=<id>')
  }

  const scenarioAbsolutePath = resolve(scenarioPathArg)
  if (!existsSync(scenarioAbsolutePath)) {
    throw new Error(`Szenario-Datei nicht gefunden: ${scenarioPathArg}`)
  }

  const scenarioToken = sanitizeScenarioOutputToken(basename(scenarioPathArg).replace(/\.[^.]+$/, ''), 'scenario')
  const scenarioFolderName = buildScenarioOutputFolderName({
    scenarioId,
    fallbackName: scenarioToken,
  })

  const ttsOutputDir = join(OUTPUT_ROOT, scenarioFolderName, 'videogenerator')
  const bootstrapArgs = appendFragmentSourceArg([
    'scripts/video-script-generator/run-annotated-video.mjs',
    '--scenario-tts',
    scenarioPathArg,
    `--scenario-id=${scenarioId}`,
    `--profile=${profileName}`,
  ], fragmentSource)
  if (ttsVoiceArg) {
    bootstrapArgs.push(ttsVoiceArg)
  }

  console.log(`Starte vollständigen Szenario-Video-Lauf für ${scenarioPathArg}...`)
  const bootstrapExitCode = runCommand('node', bootstrapArgs)
  if (bootstrapExitCode !== 0) {
    throw new Error(`Szenario-Video-Lauf fehlgeschlagen (Exit-Code ${bootstrapExitCode}).`)
  }

  const latestMeta = await findLatestRemotionMuxMeta(ttsOutputDir)
  if (!latestMeta) {
    throw new Error(`Nach dem vollständigen Lauf wurde keine Remotion-Render-Metadatei unter ${ttsOutputDir} erzeugt.`)
  }

  const metaRaw = await readFile(latestMeta.filePath, 'utf8')
  const meta = JSON.parse(metaRaw)
  const outputVideo = String(meta?.outputVideo || '').trim()
  if (!outputVideo || !existsSync(outputVideo)) {
    throw new Error(`Ausgabevideo fehlt nach vollständigem Lauf (aus ${latestMeta.filePath}): ${outputVideo || '<leer>'}`)
  }

  if (!keepTempProject && !verbose) {
    console.log(`Video frisch erzeugt: ${outputVideo}`)
    return
  }

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
