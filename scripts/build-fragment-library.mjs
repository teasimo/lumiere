#!/usr/bin/env node

/**
 * Scans all "fragements" directories and writes a fragment-library.json into each one.
 * The library maps fragment ids to workspace-relative file paths.
 *
 * Usage:
 *   npm run build:fragment-library
 *   node scripts/build-fragment-library.mjs [<fragements-dir> ...]
 */

import { readdir, readFile, writeFile } from 'fs/promises'
import { extname, join, relative, resolve } from 'path'
import { parse as parseYaml } from 'yaml'

const workspaceRoot = process.cwd()
const LIBRARY_FILE = 'fragment-library.json'

async function walkYamlFiles(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkYamlFiles(abs, files)
    } else if (entry.isFile() && ['.yaml', '.yml'].includes(extname(entry.name).toLowerCase())) {
      files.push(abs)
    }
  }
  return files
}

async function findFragementsRoots(startDir) {
  const roots = []

  async function scan(dir, depth) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue

      if (entry.name === 'fragements') {
        roots.push(join(dir, entry.name))
      } else if (depth < 3) {
        await scan(join(dir, entry.name), depth + 1)
      }
    }
  }

  await scan(startDir, 0)
  return roots
}

async function buildLibraryForDir(fragementsDir) {
  const yamlFiles = await walkYamlFiles(fragementsDir)
  const library = {}

  for (const filePath of yamlFiles) {
    let doc
    try {
      const source = await readFile(filePath, 'utf8')
      doc = parseYaml(source)
    } catch {
      continue
    }

    const fragmentId = doc?.fragment?.id
    if (fragmentId && typeof fragmentId === 'string') {
      const relPath = relative(workspaceRoot, filePath).replace(/\\/g, '/')
      if (library[fragmentId]) {
        console.warn(`Warning: duplicate fragment id "${fragmentId}" in ${relPath} (already mapped to ${library[fragmentId]})`)
      }
      library[fragmentId] = relPath
    }
  }

  const outputPath = join(fragementsDir, LIBRARY_FILE)
  await writeFile(outputPath, JSON.stringify(library, null, 2) + '\n', 'utf8')

  const relOutput = relative(workspaceRoot, outputPath)
  const count = Object.keys(library).length
  console.log(`Written ${relOutput} (${count} fragment${count === 1 ? '' : 's'})`)
  for (const [id, path] of Object.entries(library)) {
    console.log(`  ${id} -> ${path}`)
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))

  let fragementsRoots
  if (args.length > 0) {
    fragementsRoots = args.map((a) => resolve(workspaceRoot, a))
  } else {
    fragementsRoots = await findFragementsRoots(workspaceRoot)
    if (!fragementsRoots.length) {
      console.error('No "fragements" directories found in the workspace.')
      process.exitCode = 1
      return
    }
  }

  for (const dir of fragementsRoots) {
    await buildLibraryForDir(dir)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
