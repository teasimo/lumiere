#!/usr/bin/env node

import {
  buildAzureSpeechAuthContext,
  buildAzureSpeechSsml,
  DEFAULT_AZURE_TTS_OUTPUT_FORMAT,
  DEFAULT_AZURE_TTS_VOICE,
  resolveAzureSpeechBaseEndpoint,
  resolveAzureSpeechEndpoint,
  resolveAzureSpeechVoicesEndpoint,
} from '../shared/azure-speech.mjs'

const DEFAULT_VOICE = DEFAULT_AZURE_TTS_VOICE
const DEFAULT_TEXT = 'Dies ist ein kurzer Azure Speech Test.'

function parseArgs(argv) {
  const options = {
    voice: DEFAULT_VOICE,
    text: DEFAULT_TEXT,
    skipSynthesis: false,
  }

  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      options.help = true
      return options
    }
    if (token === '--skip-synthesis') {
      options.skipSynthesis = true
      continue
    }
    if (token.startsWith('--voice=')) {
      options.voice = token.slice('--voice='.length).trim() || DEFAULT_VOICE
      continue
    }
    if (token.startsWith('--text=')) {
      options.text = token.slice('--text='.length).trim() || DEFAULT_TEXT
      continue
    }

    throw new Error(`Unknown option: ${token}`)
  }

  return options
}

function printUsage() {
  console.log(`Usage:
  node scripts/video-script-generator/check-azure-speech.mjs [--voice=<voice>] [--text=<text>] [--skip-synthesis]

Required environment:
  AZURE_SPEECHSERVICES_KEY or AZURE_SPEECHSERVICES_TOKEN
  AZURE_SPEECHSERVICES_ENDPOINT
`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const authContext = buildAzureSpeechAuthContext()
  if (!authContext) {
    throw new Error('AZURE_SPEECHSERVICES_KEY oder AZURE_SPEECHSERVICES_TOKEN fehlt.')
  }

  const baseEndpoint = resolveAzureSpeechBaseEndpoint()
  const voicesEndpoint = resolveAzureSpeechVoicesEndpoint()
  const ttsEndpoint = resolveAzureSpeechEndpoint()

  console.log(`Azure Speech base endpoint: ${baseEndpoint}`)
  console.log(`Voices endpoint: ${voicesEndpoint}`)
  console.log(`TTS endpoint: ${ttsEndpoint}`)
  console.log(`Auth mode: ${authContext.authMode}`)

  const voicesResponse = await fetch(voicesEndpoint, {
    method: 'GET',
    headers: {
      ...authContext.headers,
      Accept: 'application/json',
      'User-Agent': 'lumiere-scenario-test-generator',
    },
  })

  const voicesBody = await voicesResponse.text()
  if (!voicesResponse.ok) {
    throw new Error(`Voices-Request fehlgeschlagen (${voicesResponse.status} ${voicesResponse.statusText}): ${voicesBody}`)
  }

  let voicesPayload = []
  try {
    voicesPayload = voicesBody ? JSON.parse(voicesBody) : []
  } catch (error) {
    throw new Error(`Voices-Request lieferte kein gueltiges JSON: ${error.message}`)
  }

  const matchingVoice = Array.isArray(voicesPayload)
    ? voicesPayload.find((entry) => String(entry?.ShortName || '').trim() === options.voice)
    : null

  console.log(`Voices-Request erfolgreich. Treffer fuer ${options.voice}: ${matchingVoice ? 'ja' : 'nein'}`)
  if (matchingVoice) {
    console.log(`Voice locale: ${matchingVoice.Locale || 'unknown'}`)
    console.log(`Voice status: ${matchingVoice.Status || 'unknown'}`)
  }

  if (options.skipSynthesis) {
    console.log('Synthese uebersprungen.')
    return
  }

  const ttsResponse = await fetch(ttsEndpoint, {
    method: 'POST',
    headers: {
      ...authContext.headers,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': DEFAULT_AZURE_TTS_OUTPUT_FORMAT,
      'User-Agent': 'lumiere-scenario-test-generator',
    },
    body: buildAzureSpeechSsml({
      text: options.text,
      voice: options.voice,
    }),
  })

  const responseBuffer = await ttsResponse.arrayBuffer()
  if (!ttsResponse.ok) {
    const errorBody = Buffer.from(responseBuffer).toString('utf8')
    throw new Error(`Synthese fehlgeschlagen (${ttsResponse.status} ${ttsResponse.statusText}): ${errorBody}`)
  }

  console.log(`Synthese erfolgreich. Audio-Bytes: ${responseBuffer.byteLength}`)
}

main().catch((error) => {
  console.error(String(error?.message || error))
  process.exit(1)
})
