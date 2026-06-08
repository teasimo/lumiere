// Utility to extract a code from a PDF file using a regex
// Usage: await extractCodeFromPdf(pdfPath, /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)
import fs from 'fs/promises'
import { dirname } from 'path'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

async function ensurePdfPath(pdfPath, download, response) {
  await fs.mkdir(dirname(pdfPath), { recursive: true })

  if (download) {
    // Playwright download.saveAs may keep an existing file; remove it first to force a fresh file.
    await fs.rm(pdfPath, { force: true })
    await download.saveAs(pdfPath)
    return pdfPath
  }

  if (response) {
    const pdfBuffer = await response.body()
    await fs.writeFile(pdfPath, pdfBuffer)
    return pdfPath
  }

  try {
    await fs.access(pdfPath)
    return pdfPath
  } catch {
    throw new Error(`PDF file not found: ${pdfPath}`)
  }
}

export async function extractCodeFromPdf(pdfPath, regex, options = {}) {
  const effectivePath = await ensurePdfPath(pdfPath, options.download, options.response)
  const data = new Uint8Array(await fs.readFile(effectivePath))
  const pdf = await pdfjsLib.getDocument({ data }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map(item => item.str).join(' ')
  }
  const match = text.match(regex)
  if (!match) throw new Error('No code found in PDF')
  return match[0]
}
