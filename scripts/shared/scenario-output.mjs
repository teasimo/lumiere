import { createHash } from 'crypto'
import { resolve } from 'path'

export const PERSISTENT_SCENARIO_ARTIFACTS_ROOT_DIR = 'szenario'

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

export function buildScenarioArtifactVersionToken(value, fallback = 'unknown') {
  return sanitizeScenarioOutputToken(value || fallback, fallback)
}

export function buildScenarioArtifactVersionPathSegment({
  scenarioId,
  scenarioVersion,
} = {}) {
  const normalizedScenarioId = String(scenarioId || 'scenario').trim() || 'scenario'
  const versionToken = buildScenarioArtifactVersionToken(scenarioVersion, 'unknown')
  const hashInput = `Szenario-${normalizedScenarioId}-${versionToken}`
  const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 12)
  return `${versionToken}_${hash}`
}

export function buildPersistentScenarioArtifactsRoot(workspaceRoot, scenarioId, scenarioVersion, generatorType) {
  return resolve(
    workspaceRoot,
    PERSISTENT_SCENARIO_ARTIFACTS_ROOT_DIR,
    buildScenarioOutputFolderName({ scenarioId, fallbackName: 'scenario' }),
    buildScenarioArtifactVersionPathSegment({
      scenarioId,
      scenarioVersion,
    }),
    sanitizeScenarioOutputToken(generatorType, 'generator'),
  )
}
