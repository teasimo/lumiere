import { basename, extname, resolve } from 'path'
import { appendFragmentSourceArg, resolveFragmentSourceForScenario } from './lunettes-fragment-source.mjs'

const DEFAULT_OUT_DIR = 'temp/testfiles'

export function getScenarioXmlGeneratedPaths({ scenarioPath, outDir = DEFAULT_OUT_DIR }) {
  const scenarioAbsolutePath = resolve(String(scenarioPath || ''))
  const outputDirAbsolute = resolve(String(outDir || DEFAULT_OUT_DIR))
  const scenarioName = basename(scenarioAbsolutePath, extname(scenarioAbsolutePath))

  return {
    scenarioAbsolutePath,
    outputDirAbsolute,
    scenarioName,
    specPath: resolve(outputDirAbsolute, `${scenarioName}.spec.js`),
    resolvedJsonPath: resolve(outputDirAbsolute, `${scenarioName}.resolved.json`),
    resolvedXmlPath: resolve(outputDirAbsolute, `${scenarioName}.test-resolved.xml`),
  }
}

export function buildScenarioXmlGeneratorInvocation({ scenarioPath, outDir = DEFAULT_OUT_DIR, fragmentSource = null } = {}) {
  const paths = getScenarioXmlGeneratedPaths({ scenarioPath, outDir })
  const resolvedFragmentSource = resolveFragmentSourceForScenario(fragmentSource, scenarioPath, 'lunettes')

  return {
    command: 'node',
    args: appendFragmentSourceArg([
      'scripts/test-script-generator/generate-tests-from-scenario-xml.mjs',
      paths.scenarioAbsolutePath,
      '--out-dir',
      paths.outputDirAbsolute,
    ], resolvedFragmentSource),
    fragmentSource: resolvedFragmentSource,
    paths,
  }
}
