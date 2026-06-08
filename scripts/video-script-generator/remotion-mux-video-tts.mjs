#!/usr/bin/env node

import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { tmpdir } from 'os'

function parseArgs(argv) {
  let planPath = null
  let tsxPath = null
  let keepTempProject = false
  for (const arg of argv) {
    if (arg.startsWith('--plan=')) {
      planPath = arg.slice('--plan='.length).trim()
      continue
    }
    if (arg.startsWith('--tsx=')) {
      tsxPath = arg.slice('--tsx='.length).trim()
      continue
    }
    if (arg === '--keep-temp-project') {
      keepTempProject = true
      continue
    }
    if (!planPath && !arg.startsWith('-')) {
      planPath = arg
    }
  }

  if (!planPath) {
    throw new Error('Usage: node scripts/video-script-generator/remotion-mux-video-tts.mjs --plan=<path-to-plan.json> --tsx=<path-to-composition.tsx>')
  }

  if (!tsxPath) {
    throw new Error('TSX composition is required. Pass --tsx=<path-to-composition.tsx>.')
  }

  return {
    planPath: resolve(planPath),
    tsxPath: tsxPath ? resolve(tsxPath) : null,
    keepTempProject,
  }
}

function sanitizeFileToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function normalizeRelativeImportPath(value) {
  const normalized = toPosixPath(value)
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}

async function resolveImportSourcePath(fromFilePath, importSpecifier) {
  const basePath = resolve(dirname(fromFilePath), importSpecifier)
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
    join(basePath, 'index.js'),
    join(basePath, 'index.jsx'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Relative import not found from ${fromFilePath}: ${importSpecifier}`)
}

function ensureStaticFileResolver(tsxRaw, resolverBlock) {
  const remotionImportPattern = /import\s*\{\s*([^}]+)\}\s*from\s*'remotion'/
  if (remotionImportPattern.test(tsxRaw)) {
    const withStaticFile = tsxRaw.replace(
      remotionImportPattern,
      (full, importsRaw) => {
        const imports = String(importsRaw || '')
        if (imports.includes('staticFile')) {
          return full
        }
        return `import { ${imports.trim()}, staticFile } from 'remotion'`
      }
    )

    return withStaticFile.replace(/(import\s+\{[\s\S]*?\}\s+from\s+'remotion'\s*\n)/, `$1${resolverBlock}`)
  }

  return [
    "import { staticFile } from 'remotion'",
    resolverBlock.trimEnd(),
    tsxRaw,
  ].join('\n')
}

async function stageTsxDependencyGraph({
  sourcePath,
  destPath,
  srcDir,
  moduleCache,
  transformSource,
}) {
  const normalizedSourcePath = resolve(sourcePath)
  if (moduleCache.has(normalizedSourcePath)) {
    return moduleCache.get(normalizedSourcePath)
  }

  moduleCache.set(normalizedSourcePath, destPath)
  let sourceRaw = await readFile(normalizedSourcePath, 'utf8')

  const importSpecifiers = new Set()
  sourceRaw.replace(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g, (_full, specifier) => {
    importSpecifiers.add(String(specifier))
    return _full
  })
  sourceRaw.replace(/import\s+['"](\.{1,2}\/[^'"]+)['"]/g, (_full, specifier) => {
    importSpecifiers.add(String(specifier))
    return _full
  })

  const rewrittenImports = new Map()
  for (const importSpecifier of importSpecifiers) {
    const dependencySourcePath = await resolveImportSourcePath(normalizedSourcePath, importSpecifier)
    const dependencyExt = extname(dependencySourcePath) || '.ts'
    const dependencyToken = sanitizeFileToken(relative(dirname(sourcePath), dependencySourcePath)) || `module-${moduleCache.size}`
    const dependencyDestPath = join(srcDir, 'deps', `${dependencyToken}${dependencyExt}`)
    const stagedDependencyPath = await stageTsxDependencyGraph({
      sourcePath: dependencySourcePath,
      destPath: dependencyDestPath,
      srcDir,
      moduleCache,
      transformSource: null,
    })
    const rewrittenSpecifier = normalizeRelativeImportPath(relative(dirname(destPath), stagedDependencyPath))
    rewrittenImports.set(importSpecifier, rewrittenSpecifier)
  }

  for (const [before, after] of rewrittenImports.entries()) {
    const escapedBefore = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    sourceRaw = sourceRaw
      .replace(new RegExp(`from\\s+['\"]${escapedBefore}['\"]`, 'g'), `from '${after}'`)
      .replace(new RegExp(`import\\s+['\"]${escapedBefore}['\"]`, 'g'), `import '${after}'`)
  }

  if (typeof transformSource === 'function') {
    sourceRaw = transformSource(sourceRaw)
  }

  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, sourceRaw, 'utf8')
  return destPath
}

async function stageMediaToPublic({ workDir, plan }) {
  const publicDir = join(workDir, 'public')
  await mkdir(publicDir, { recursive: true })

  const inputVideo = resolve(String(plan.inputVideo || ''))
  const videoExt = extname(inputVideo) || '.mp4'
  const stagedVideoName = `video${videoExt}`
  await copyFile(inputVideo, join(publicDir, stagedVideoName))

  const sourceTracks = Array.isArray(plan.narrations)
    ? plan.narrations
    : Array.isArray(plan.audioTracks)
      ? plan.audioTracks
      : []

  const audioTracks = []
  for (let index = 0; index < sourceTracks.length; index += 1) {
    const track = sourceTracks[index]
    const absoluteAudioPath = resolve(String(track?.file || ''))
    const sourceName = basename(absoluteAudioPath)
    const sourceExt = extname(sourceName) || '.mp3'
    const rawBase = sourceName.slice(0, sourceName.length - sourceExt.length)
    const safeBase = sanitizeFileToken(rawBase) || `track-${index + 1}`
    const stagedName = `audio-${String(index + 1).padStart(3, '0')}-${safeBase}${sourceExt}`
    await copyFile(absoluteAudioPath, join(publicDir, stagedName))

    audioTracks.push({
      id: String(track?.id || `track-${index + 1}`),
      src: stagedName,
      startMs: Math.max(0, Number(track?.startMs) || 0),
    })
  }

  return {
    stagedVideoName,
    audioTracks,
  }
}

async function stageExtraAssetsFromTsx({ tsxPath, publicDir }) {
  const tsxRaw = await readFile(tsxPath, 'utf8')
  const absoluteAssets = []
  const seen = new Set()
  const pattern = /__stagedAsset\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/g
  let match
  while ((match = pattern.exec(tsxRaw)) != null) {
    const quoted = String(match[1] || '').trim()
    if (!quoted) continue

    let candidate = ''
    try {
      candidate = JSON.parse(quoted.startsWith("'") ? `"${quoted.slice(1, -1).replace(/\\/g, '\\\\').replace(/\"/g, '\\\"')}"` : quoted)
    } catch {
      continue
    }

    const absolutePath = resolve(String(candidate || ''))
    if (!absolutePath.startsWith('/')) continue
    if (!existsSync(absolutePath)) continue
    if (seen.has(absolutePath)) continue
    seen.add(absolutePath)
    absoluteAssets.push(absolutePath)
  }

  const stagedMap = {}
  for (let index = 0; index < absoluteAssets.length; index += 1) {
    const absolutePath = absoluteAssets[index]
    const sourceName = basename(absolutePath)
    const sourceExt = extname(sourceName)
    const rawBase = sourceExt ? sourceName.slice(0, sourceName.length - sourceExt.length) : sourceName
    const safeBase = sanitizeFileToken(rawBase) || `asset-${index + 1}`
    const stagingToken = `asset-${String(index + 1).padStart(3, '0')}-${safeBase}`
    const stagedName = `${stagingToken}${sourceExt}`
    await copyFile(absolutePath, join(publicDir, stagedName))
    stagedMap[absolutePath] = stagedName
  }

  return stagedMap
}

async function createRemotionProjectFromTsx({ workDir, tsxPath, plan }) {
  const srcDir = join(workDir, 'src')
  await mkdir(srcDir, { recursive: true })
  const stagedMedia = await stageMediaToPublic({ workDir, plan })
  const publicDir = join(workDir, 'public')
  const stagedExtraAssetMap = await stageExtraAssetsFromTsx({ tsxPath, publicDir })

  const userCompositionPath = join(srcDir, 'UserComposition.tsx')
  const rootPath = join(srcDir, 'Root.tsx')
  const entryPath = join(srcDir, 'index.ts')

  const assetMap = {}
  const inputVideoAbsolute = resolve(String(plan.inputVideo || ''))
  assetMap[inputVideoAbsolute] = stagedMedia.stagedVideoName

  const sourceTracks = Array.isArray(plan.narrations)
    ? plan.narrations
    : Array.isArray(plan.audioTracks)
      ? plan.audioTracks
      : []

  for (let index = 0; index < sourceTracks.length; index += 1) {
    const track = sourceTracks[index]
    const absoluteAudioPath = resolve(String(track?.file || ''))
    const staged = stagedMedia.audioTracks[index]
    if (!staged) continue
    assetMap[absoluteAudioPath] = staged.src
  }

  Object.assign(assetMap, stagedExtraAssetMap)

  const resolverBlock = [
    '',
    `const __STAGED_ASSET_MAP = ${JSON.stringify(assetMap, null, 2)} as const`,
    '',
    'function __stagedAsset(path: string) {',
    '  const key = String(path || "")',
    '  const mapped = (key && (Object.prototype.hasOwnProperty.call(__STAGED_ASSET_MAP, key)',
    '    ? (__STAGED_ASSET_MAP as Record<string, string>)[key]',
    '    : null)) || key',
    '  return staticFile(mapped)',
    '}',
    '',
  ].join('\n')

  await stageTsxDependencyGraph({
    sourcePath: tsxPath,
    destPath: userCompositionPath,
    srcDir,
    moduleCache: new Map(),
    transformSource: (tsxRaw) => {
      const withResolver = ensureStaticFileResolver(tsxRaw, resolverBlock)
      return withResolver
        .split('staticFile(SOURCE_VIDEO)')
        .join('__stagedAsset(SOURCE_VIDEO)')
        .split('staticFile(track.file)')
        .join('__stagedAsset(track.file)')
        .split('sourceVideo={SOURCE_VIDEO}')
        .join('sourceVideo={__stagedAsset(SOURCE_VIDEO)}')
        .split('sourceVideo={semanticVideoPlan.source.videoPath}')
        .join('sourceVideo={__stagedAsset(semanticVideoPlan.source.videoPath)}')
        .split('src={semanticVideoPlan.source.videoPath}')
        .join('src={__stagedAsset(semanticVideoPlan.source.videoPath)}')
        .split('src={unifiedArchitecture.mux.inputVideo}')
        .join('src={__stagedAsset(unifiedArchitecture.mux.inputVideo)}')
        .split('src={track.file}')
        .join('src={__stagedAsset(track.file)}')
        .replace(/sourceVideo=\{([A-Za-z0-9_$.]+\.source\.videoPath)\}/g, 'sourceVideo={__stagedAsset($1)}')
        .replace(/src=\{([A-Za-z0-9_$.]+\.source\.videoPath)\}/g, 'src={__stagedAsset($1)}')
    },
  })

  const fps = Number(plan.fps) || 30
  const width = Number(plan.width) || 1280
  const height = Number(plan.height) || 720
  const durationInFrames = Math.max(
    1,
    Number(plan.durationInFrames) || Math.ceil((Number(plan.outputDurationSec) || 1) * fps)
  )

  const rootTsx = [
    "import React from 'react'",
    "import { Composition } from 'remotion'",
    "import UserComposition from './UserComposition'",
    '',
    'export const RemotionRoot: React.FC = () => {',
    '  return (',
    '    <Composition',
    '      id="NarrationMux"',
    '      component={UserComposition}',
    `      width={${width}}`,
    `      height={${height}}`,
    `      fps={${fps}}`,
    `      durationInFrames={${durationInFrames}}`,
    '    />',
    '  )',
    '}',
    '',
  ].join('\n')

  const entryTs = [
    "import { registerRoot } from 'remotion'",
    "import { RemotionRoot } from './Root'",
    '',
    'registerRoot(RemotionRoot)',
    '',
  ].join('\n')

  await writeFile(rootPath, rootTsx, 'utf8')
  await writeFile(entryPath, entryTs, 'utf8')

  return { entryPath }
}

async function main() {
  const { planPath, tsxPath, keepTempProject } = parseArgs(process.argv.slice(2))
  const formatTimestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')
  const logWithTimestamp = (message) => {
    console.log(`[${formatTimestamp()}] ${message}`)
  }

  if (!existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`)
  }
  if (!existsSync(tsxPath)) {
    throw new Error(`TSX file not found: ${tsxPath}`)
  }

  const rawPlan = await readFile(planPath, 'utf8')
  const plan = JSON.parse(rawPlan)

  const inputVideo = resolve(String(plan.inputVideo || ''))
  const outputVideo = resolve(String(plan.outputVideo || ''))
  const audioTracks = Array.isArray(plan.narrations) ? plan.narrations : Array.isArray(plan.audioTracks) ? plan.audioTracks : []

  if (!existsSync(inputVideo)) {
    throw new Error(`Input video not found: ${inputVideo}`)
  }
  for (const track of audioTracks) {
    if (!existsSync(resolve(String(track.file || '')))) {
      throw new Error(`Audio file not found: ${track.file}`)
    }
  }

  const workDir = join(tmpdir(), `remotion-mux-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await mkdir(workDir, { recursive: true })

  try {
    logWithTimestamp(`[render] Preparing temp project in ${workDir}`)
    const { entryPath } = await createRemotionProjectFromTsx({ workDir, tsxPath, plan })
    logWithTimestamp('[render] Temp project prepared')

    const { bundle } = await import('@remotion/bundler')
    const { renderMedia, selectComposition } = await import('@remotion/renderer')

    logWithTimestamp('[render] Bundling Remotion project...')
    const serveUrl = await bundle({
      entryPoint: entryPath,
      rootDir: workDir,
      publicDir: join(workDir, 'public'),
    })
    logWithTimestamp('[render] Bundle ready')

    logWithTimestamp('[render] Selecting composition...')
    const composition = await selectComposition({
      serveUrl,
      id: 'NarrationMux',
    })
    logWithTimestamp('[render] Composition selected, rendering media...')

    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      audioCodec: 'aac',
      outputLocation: outputVideo,
      chromiumOptions: {
        gl: 'swangle',
      },
    })
    logWithTimestamp('[render] Render complete')
  } finally {
    if (keepTempProject) {
      logWithTimestamp(`[render:debug] Temp project kept at: ${workDir}`)
    } else {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  logWithTimestamp(`Remotion video created: ${outputVideo}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
