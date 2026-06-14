export function normalizeFragmentSource(value, fallback = 'lunettes') {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'lunettes' ? 'lunettes' : fallback
}

export function shouldDefaultToLunettesFragmentSource(scenarioPath) {
  const normalizedPath = String(scenarioPath || '').replace(/\\/g, '/').trim()
  return normalizedPath.includes('/interactions/_lunettes-job-watcher/')
}

export function resolveFragmentSourceForScenario(fragmentSource, scenarioPath, fallback = 'local') {
  void scenarioPath
  return normalizeFragmentSource(fragmentSource, normalizeFragmentSource('', fallback))
}

export function isLunettesFragmentSource(value) {
  return normalizeFragmentSource(value) === 'lunettes'
}

export function appendFragmentSourceArg(args, fragmentSource) {
  const normalized = normalizeFragmentSource(fragmentSource)
  if (!normalized) {
    return args
  }

  return [
    ...args,
    `--fragment-source=${normalized}`,
  ]
}
