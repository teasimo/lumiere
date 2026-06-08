import { existsSync, readFileSync } from 'fs'
import { relative, resolve } from 'path'

const DEFAULTS = {
  'test-script': {
    defaults: {
      scenario_path: 'neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml',
      scenario_dir: 'neo/interactions',
      output_dir: 'temp/testfiles',
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
    presentation: {
      slide: {
        default_duration_ms: 2000,
        inline_default_duration_ms: 3000,
      },
    },
    tts: [],
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

export function loadCentralConfig(workspaceRoot) {
  const configAbsolutePath = resolve(workspaceRoot, 'scenario.config.json')
  if (!existsSync(configAbsolutePath)) {
    return {
      config: DEFAULTS,
      sourcePathRelative: relative(workspaceRoot, configAbsolutePath),
      exists: false,
    }
  }

  try {
    const raw = readFileSync(configAbsolutePath, 'utf8')
    const parsed = JSON.parse(raw)
    const payload = normalizeScenarioConfigPayload(isPlainObject(parsed.scenario) ? parsed.scenario : parsed)
    const merged = deepMerge(DEFAULTS, payload)
    return {
      config: merged,
      sourcePathRelative: relative(workspaceRoot, configAbsolutePath),
      exists: true,
    }
  } catch (error) {
    throw new Error(`Failed to parse central config JSON at ${relative(workspaceRoot, configAbsolutePath)}: ${error.message}`)
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
