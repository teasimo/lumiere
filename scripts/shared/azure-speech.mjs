export const DEFAULT_AZURE_TTS_VOICE = 'de-DE-KatjaNeural'
export const DEFAULT_AZURE_TTS_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'

const LEGACY_TTS_VOICE_MAP = {
  'de-DE-Neural2-B': DEFAULT_AZURE_TTS_VOICE,
  'de-DE-Chirp3-HD-Laomedeia': DEFAULT_AZURE_TTS_VOICE,
}

export function resolveAzureSpeechBaseEndpoint() {
  const endpoint = String(process.env.AZURE_SPEECHSERVICES_ENDPOINT || '').trim()
  if (!endpoint) {
    throw new Error('AZURE_SPEECHSERVICES_ENDPOINT fehlt.')
  }

  return endpoint.endsWith('/') ? endpoint : `${endpoint}/`
}

export function resolveAzureSpeechEndpoint() {
  const baseEndpoint = resolveAzureSpeechBaseEndpoint()
  const endpointUrl = new URL(baseEndpoint)

  if (/^[a-z0-9-]+\.api\.cognitive\.microsoft\.com$/i.test(endpointUrl.hostname)) {
    const region = endpointUrl.hostname.replace(/\.api\.cognitive\.microsoft\.com$/i, '')
    return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`
  }

  return new URL('cognitiveservices/v1', baseEndpoint).toString()
}

export function resolveAzureSpeechVoicesEndpoint() {
  return new URL('tts/cognitiveservices/voices/list', resolveAzureSpeechBaseEndpoint()).toString()
}

export function buildAzureSpeechAuthContext() {
  const key = String(process.env.AZURE_SPEECHSERVICES_KEY || '').trim()
  if (key) {
    return {
      headers: {
        'Ocp-Apim-Subscription-Key': key,
      },
      authMode: 'subscription-key',
    }
  }

  const token = String(process.env.AZURE_SPEECHSERVICES_TOKEN || '').trim()
  if (token) {
    return {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      authMode: 'bearer-token',
    }
  }

  return null
}

export function normalizeAzureTtsVoiceName(voice) {
  const value = typeof voice === 'string' ? voice.trim() : ''
  if (!value) {
    return DEFAULT_AZURE_TTS_VOICE
  }
  return LEGACY_TTS_VOICE_MAP[value] || value
}

export function inferLocaleFromAzureVoiceName(voice) {
  const match = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice)
  return match ? match[1] : 'de-DE'
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function buildAzureSpeechSsml({ text = '', ssml = '', voice }) {
  if (typeof ssml === 'string' && ssml.trim()) {
    return ssml
  }

  const normalizedVoice = normalizeAzureTtsVoiceName(voice)
  const locale = inferLocaleFromAzureVoiceName(normalizedVoice)
  return `<speak version="1.0" xml:lang="${locale}" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="${escapeXml(normalizedVoice)}">${escapeXml(text)}</voice></speak>`
}
