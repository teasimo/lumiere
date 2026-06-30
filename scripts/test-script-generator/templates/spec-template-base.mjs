import { basename } from 'path'

const SCENARIO_HELPER_EXPORT_NAMES = [
  'applyAppendValue',
  'applyAppendValueById',
  'applyClickValueById',
  'applyClickValueBySelector',
  'applyFillValue',
  'applyFillValueById',
  'applyReplaceValue',
  'applyReplaceValueById',
  'applySelectValue',
  'applySelectValueById',
  'applyUploadValue',
  'applyUploadValueById',
  'assertElementValueById',
  'assertElementValueByTestId',
  'configureScenarioHelpers',
  'cloneRuntimeVariables',
  'createScenarioTimelineRuntime',
  'createScenarioExecutionRuntime',
  'createScenarioExecutionState',
  'createStepDomIdentifierLogger',
  'prepareScenarioFlow',
  'runPreparedScenarioFlow',
  'describeScenarioStep',
  'buildScenarioStepMeta',
  'executeScenarioStep',
  'describeTargetAvailability',
  'executeScenarioApiRequest',
  'isLocatorInViewport',
  'pickIndexedLocator',
  'readActivationCodeFromMailhog',
  'readScenarioApiResponseValue',
  'resolveTargetLocator',
  'resolveRuntimeTemplateString',
  'scrollToLocator',
  'searchAndSelect',
  'seedRuntimeVariables',
  'applyAppendValueToLocator',
  'applyClickValueToLocator',
  'applyFillValueToLocator',
  'applyReplaceValueToLocator',
  'applySelectValueToLocator',
  'applyUploadValueToLocator',
  'assertElementValueByLocator',
  'setRuntimeVariable',
  'shouldRunStepFromGuards',
  'waitForCondition',
]

export function getScenarioSpecImports() {
  return [
    "import { test, expect } from '@playwright/test'",
    `import { ${SCENARIO_HELPER_EXPORT_NAMES.join(', ')} } from "./scenario-helpers.mjs"`,
    '',
  ]
}

export function getScenarioSpecSetupLines({
  envFillStrategiesImportPath = null,
  scrollStepPx = 20,
} = {}) {
  return [
    `configureScenarioHelpers({ envFillStrategiesImportPath: ${JSON.stringify(envFillStrategiesImportPath)}, scrollStepPx: ${JSON.stringify(scrollStepPx)} })`,
    '',
  ]
}

export function getScenarioSpecSupportFilenames() {
  return {
    scenarioHelpers: 'scenario-helpers.mjs',
    scenarioRuntime: 'generated-scenario-runtime.js',
    centralFillStrategies: 'central-fill-strategies.mjs',
    extractPdfCode: 'extract-pdf-code.mjs',
  }
}

export function getScenarioEnvFillStrategiesFilename(specOutputPath) {
  const normalized = String(specOutputPath || '').replace(/\\/g, '/')
  const filename = basename(normalized)
  if (filename.endsWith('.spec.js')) {
    return `${filename.slice(0, -'.spec.js'.length)}.env-fill-strategies.mjs`
  }
  return `${filename || 'scenario'}.env-fill-strategies.mjs`
}
