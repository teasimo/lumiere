import { resolve } from 'path'

export function sanitizeScenarioOutputToken(value, fallback = 'scenario') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

export function buildScenarioOutputFolderName({ scenarioId, fallbackName = 'scenario' } = {}) {
  return sanitizeScenarioOutputToken(scenarioId || fallbackName, fallbackName)
}

export function buildScenarioOutputRoot(workspaceRoot, scenarioId, fallbackName = 'scenario') {
  return resolve(workspaceRoot, 'output', buildScenarioOutputFolderName({ scenarioId, fallbackName }))
}
