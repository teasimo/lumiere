import { existsSync, readFileSync } from 'fs'
import { relative, resolve } from 'path'

const DEFAULTS = {
  'test-script': {
    defaults: {
      scenario_path: 'neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml',
      scenario_dir: 'neo/interactions',
      output_dir: 'temp/testfiles',
    },
    runtime: {
      step_timeout_ms: 30000,
    },
    lunettes_api: {
      base_url: '',
    },
    video: {
      wait_between_steps: 0,
      scroll_delay_ms: 35,
      scroll_step_px: 20,
      autoscroll_smooth: false,
      resolution: {
        width: 1280,
        height: 720,
      },
    },
  },
  'video-script': {
    intro: {
      enabled: true,
      path: 'neo/assets/video-intro.mp4',
    },
    render: {
      fps: null,
      encoding: {
        preset: 'veryfast',
        crf: 18,
        video_bitrate: null,
        audio_bitrate: '192k',
        pix_fmt: 'yuv420p',
      },
    },
    presentation: {
      indicators: {
        click: {
          enabled: true,
          before_ms: 100,
          after_ms: 100,
          fade_ms: 50,
        },
      },
      step_timing: {
        before_interaction_ms: 500,
        after_interaction_ms: 500,
      },
      slide: {
        default_duration_ms: 2000,
        inline_default_duration_ms: 3000,
      },
    },
    tts: [],
  },
  'publish-to-confluence': {
    parent_page_id: '',
  },
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? { ...override } : override
  }

  const out = { ...base }
  if (!isPlainObject(override)) {
    return out
  }

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }

  return out
}

export function normalizeSoftwareConfigToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function parseConfigFile(workspaceRoot, configAbsolutePath) {
  const raw = readFileSync(configAbsolutePath, 'utf8')
  const parsed = JSON.parse(raw)
  const payload = isPlainObject(parsed.scenario) ? parsed.scenario : parsed
  return {
    payload: normalizeScenarioConfigPayload(payload),
    sourcePathRelative: relative(workspaceRoot, configAbsolutePath),
  }
}

function extractSoftwareConfigOverride(payload, software) {
  const normalizedSoftware = normalizeSoftwareConfigToken(software)
  if (!normalizedSoftware || !isPlainObject(payload?.software)) {
    return {}
  }

  const softwareEntries = payload.software
  const matchingKey = Object.keys(softwareEntries).find((key) => normalizeSoftwareConfigToken(key) === normalizedSoftware)
  if (!matchingKey || !isPlainObject(softwareEntries[matchingKey])) {
    return {}
  }

  return normalizeScenarioConfigPayload(softwareEntries[matchingKey])
}

export function loadCentralConfig(workspaceRoot, { software = null } = {}) {
  const normalizedSoftware = normalizeSoftwareConfigToken(software)
  const softwareConfigAbsolutePath = normalizedSoftware
    ? resolve(workspaceRoot, `scenario.config.${normalizedSoftware}.json`)
    : null
  const defaultConfigAbsolutePath = resolve(workspaceRoot, 'scenario.config.json')
  const hasDefaultConfig = existsSync(defaultConfigAbsolutePath)
  const hasSoftwareConfig = Boolean(softwareConfigAbsolutePath && existsSync(softwareConfigAbsolutePath))
  const preferredConfigAbsolutePath = hasSoftwareConfig ? softwareConfigAbsolutePath : defaultConfigAbsolutePath

  if (!existsSync(preferredConfigAbsolutePath)) {
    return {
      config: DEFAULTS,
      sourcePathRelative: relative(workspaceRoot, preferredConfigAbsolutePath),
      exists: false,
    }
  }

  try {
    const defaultConfigFile = hasDefaultConfig ? parseConfigFile(workspaceRoot, defaultConfigAbsolutePath) : null
    const softwareConfigFile = hasSoftwareConfig ? parseConfigFile(workspaceRoot, softwareConfigAbsolutePath) : null
    const selectedConfigFile = softwareConfigFile || defaultConfigFile
    const basePayload = defaultConfigFile?.payload ? { ...defaultConfigFile.payload } : {}
    const selectedPayload = selectedConfigFile?.payload ? { ...selectedConfigFile.payload } : {}
    const mergedBasePayload = hasSoftwareConfig
      ? deepMerge(basePayload, selectedPayload)
      : selectedPayload
    const softwareOverride = deepMerge(
      extractSoftwareConfigOverride(basePayload, software),
      extractSoftwareConfigOverride(selectedPayload, software),
    )
    delete mergedBasePayload.software
    const merged = deepMerge(deepMerge(DEFAULTS, mergedBasePayload), softwareOverride)
    return {
      config: merged,
      sourcePathRelative: selectedConfigFile?.sourcePathRelative || relative(workspaceRoot, preferredConfigAbsolutePath),
      exists: true,
    }
  } catch (error) {
    throw new Error(`Failed to parse central config JSON at ${relative(workspaceRoot, preferredConfigAbsolutePath)}: ${error.message}`)
  }
}

function normalizeScenarioConfigPayload(payload) {
  if (!isPlainObject(payload)) {
    return {}
  }

  const normalized = { ...payload }
  const legacyTestScriptPayload = {}

  if (isPlainObject(payload.defaults)) {
    legacyTestScriptPayload.defaults = payload.defaults
  }

  if (isPlainObject(payload.video)) {
    legacyTestScriptPayload.video = payload.video
  }

  if (Object.keys(legacyTestScriptPayload).length > 0) {
    normalized['test-script'] = deepMerge(legacyTestScriptPayload, normalized['test-script'])
  }

  if (Array.isArray(payload.tts)) {
    normalized['video-script'] = deepMerge({ tts: payload.tts }, normalized['video-script'])
  }

  delete normalized.defaults
  delete normalized.video
  delete normalized.tts

  return normalized
}

export function getTestScriptConfig(config) {
  return isPlainObject(config?.['test-script']) ? config['test-script'] : {}
}

export function getVideoScriptConfig(config) {
  return isPlainObject(config?.['video-script']) ? config['video-script'] : {}
}
