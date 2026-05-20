import { basename } from 'path'
import { getAllTemplateParts } from './spec-template-base.mjs'

function slugify(input) {
  return String(input || 'scenario')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'scenario'
}

function toLiteral(value) {
  return JSON.stringify(value)
}

function toConditionList(value, keyName, stepId) {
  if (value == null) {
    return []
  }

  if (Array.isArray(value)) {
    return value
  }

  if (typeof value === 'object') {
    return [value]
  }

  throw new Error(`Step "${stepId}" has invalid "${keyName}" guard. Use an object or array of objects.`)
}

function buildGenericTargetSelector(target) {
  const reservedKeys = new Set(['testid', 'id', 'data-id', 'text', 'role', 'url', 'state', 'click_child_selector'])
  const entries = Object.entries(target || {}).filter(([, value]) => value != null)
  const selectorParts = []

  for (const [key, value] of entries) {
    if (reservedKeys.has(key)) {
      continue
    }

    selectorParts.push(`[${key}=${JSON.stringify(String(value))}]`)
  }

  return selectorParts.length > 0 ? selectorParts.join('') : null
}

function buildExpectedResultAssertions(expectedResults) {
  const lines = []

  for (const rawResult of expectedResults || []) {
    const result = rawResult || {}
    const target = result.target || {}
    const state = result.state || target.state || {}

    if (target.testid) {
      const testId = String(target.testid)
      const locator = `page.getByTestId(${toLiteral(testId)}).first()`

      if (state.visible === true) {
        lines.push(`await expect(${locator}).toBeVisible()`)
      }

      if (state.visible === false) {
        lines.push(`await expect(${locator}).toBeHidden()`)
      }

      if (state['value-present'] === true) {
        lines.push(`await expect(${locator}).toHaveValue(/.+/)`)
      }

      if (state['value-present'] === false) {
        lines.push(`await expect(${locator}).toHaveValue('')`)
      }
    } else if (target.text) {
      const locator = target.role
        ? `page.getByRole(${toLiteral(String(target.role))}, { name: ${toLiteral(String(target.text))}, exact: true }).first()`
        : `page.getByText(${toLiteral(String(target.text))}, { exact: true }).first()`

      if (state.visible === true) {
        lines.push(`await expect(${locator}).toBeVisible()`)
      }

      if (state.visible === false) {
        lines.push(`await expect(${locator}).toBeHidden()`)
      }

      if (state['value-present'] === true) {
        lines.push(`await expect(${locator}).toHaveValue(/.+/)`)
      }

      if (state['value-present'] === false) {
        lines.push(`await expect(${locator}).toHaveValue('')`)
      }
    } else {
      const genericSelector = buildGenericTargetSelector(target)
      if (genericSelector) {
        const locator = `page.locator(${toLiteral(genericSelector)}).first()`

        if (state.visible === true) {
          lines.push(`await expect(${locator}).toBeVisible()`)
        }

        if (state.visible === false) {
          lines.push(`await expect(${locator}).toBeHidden()`)
        }

        if (state['value-present'] === true) {
          lines.push(`await expect(${locator}).toHaveValue(/.+/)`)
        }

        if (state['value-present'] === false) {
          lines.push(`await expect(${locator}).toHaveValue('')`)
        }
      }
    }

    if (target.id) {
      const id = String(target.id)
      const locator = `page.locator(${toLiteral(`[id=${JSON.stringify(id)}]`)}).first()`

      if (state.visible === true) {
        lines.push(`await expect(${locator}).toBeVisible()`)
      }

      if (state.visible === false) {
        lines.push(`await expect(${locator}).toBeHidden()`)
      }

      if (state['value-present'] === true) {
        lines.push(`await expect(${locator}).toHaveValue(/.+/)`)
      }

      if (state['value-present'] === false) {
        lines.push(`await expect(${locator}).toHaveValue('')`)
      }
    }

    if (target['data-id']) {
      const dataId = String(target['data-id'])
      const locator = `page.locator(${toLiteral(`[data-id=${JSON.stringify(dataId)}]`)}).first()`

      if (state.visible === true) {
        lines.push(`await expect(${locator}).toBeVisible()`)
      }

      if (state.visible === false) {
        lines.push(`await expect(${locator}).toBeHidden()`)
      }

      if (state['value-present'] === true) {
        lines.push(`await expect(${locator}).toHaveValue(/.+/)`)
      }

      if (state['value-present'] === false) {
        lines.push(`await expect(${locator}).toHaveValue('')`)
      }
    }

    if (target.url) {
      lines.push(`await expect(page).toHaveURL(${toLiteral(String(target.url))})`)
    }
  }

  return lines
}

function buildInteractionLines(step) {
  const interaction = step.interaction || {}
  const interactionType = String(interaction.type || '').trim().toLowerCase()
  const target = interaction.target || {}
  const lines = []

  if (interactionType === 'open') {
    if (!target.url) {
      throw new Error(`Step "${step.id}" has interaction type "open" but no target.url.`)
    }
    lines.push(`await page.goto(${toLiteral(String(target.url))}, { waitUntil: 'networkidle' })`)
  } else if (interactionType === 'fill') {
    if (interaction.value == null && target.value != null) {
      throw new Error(
        `Step "${step.id}" has misplaced fill value. Put "value" under "interaction", not under "interaction.target".`
      )
    }
    if (target.testid) {
      lines.push(`await applyFillValue(page, ${toLiteral(String(target.testid))}, resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables))`)
    } else if (target.text) {
      // Fill by visible text (first matching input/textarea/select)
      lines.push(`await page.getByLabel(resolveRuntimeTemplateString(${toLiteral(String(target.text))}, runtimeVariables), { exact: true }).fill(resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables))`)
    } else if (buildGenericTargetSelector(target)) {
      // Fill by generic selector
      lines.push(`await page.locator(resolveRuntimeTemplateString(${toLiteral(buildGenericTargetSelector(target))}, runtimeVariables)).first().fill(resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables))`)
    } else if (target.id || target['data-id']) {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyFillValueById(page, ${toLiteral(String(value))}, resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables), ${toLiteral(selectorType)})`)
    } else {
      throw new Error(`Step "${step.id}" has interaction type "fill" but no usable target fields.`)
    }
  } else if (interactionType === 'append') {
    if (!target.testid && !target.id && !target['data-id']) {
      throw new Error(`Step "${step.id}" has interaction type "append" but no target.testid, target.id, or target.data-id.`)
    }
    if (interaction.value == null && target.value != null) {
      throw new Error(
        `Step "${step.id}" has misplaced append value. Put "value" under "interaction", not under "interaction.target".`
      )
    }
    if (target.testid) {
      lines.push(`await applyAppendValue(page, ${toLiteral(String(target.testid))}, ${toLiteral(String(interaction.value || ''))})`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyAppendValueById(page, ${toLiteral(String(value))}, ${toLiteral(String(interaction.value || ''))}, ${toLiteral(selectorType)})`)
    }
  } else if (interactionType === 'click') {
    if (!target.testid && !target.id && !target['data-id'] && !target.text && !buildGenericTargetSelector(target)) {
      throw new Error(`Step "${step.id}" has interaction type "click" but no usable target fields.`)
    }
    if (target.text) {
      const textValue = toLiteral(String(target.text))
      if (target.role) {
        const baseLocator = `page.getByRole(${toLiteral(String(target.role))}, { name: ${textValue}, exact: true }).first()`
        if (target.click_child_selector) {
          lines.push(`await ${baseLocator}.locator(${toLiteral(String(target.click_child_selector))}).first().click()`)
        } else {
          lines.push(`await ${baseLocator}.click()`)
        }
      } else {
        const baseLocator = `page.getByText(${textValue}, { exact: true }).first()`
        if (target.click_child_selector) {
          lines.push(`await ${baseLocator}.locator(${toLiteral(String(target.click_child_selector))}).first().click()`)
        } else {
          lines.push(`await ${baseLocator}.click()`)
        }
      }
    } else if (target.testid) {
      lines.push(`await page.getByTestId(${toLiteral(String(target.testid))}).click()`)
    } else if (buildGenericTargetSelector(target)) {
      lines.push(`await applyClickValueBySelector(page, ${toLiteral(buildGenericTargetSelector(target))})`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyClickValueById(page, ${toLiteral(String(value))}, ${toLiteral(selectorType)})`)
    }
  } else if (interactionType === 'select') {
    if (!target.testid && !target.id && !target['data-id']) {
      throw new Error(`Step "${step.id}" has interaction type "select" but no target.testid, target.id, or target.data-id.`)
    }
    if (interaction.value == null && target.value != null) {
      throw new Error(
        `Step "${step.id}" has misplaced select value. Put "value" under "interaction", not under "interaction.target".`
      )
    }
    if (target.testid) {
      lines.push(`await applySelectValue(page, ${toLiteral(String(target.testid))}, ${toLiteral(String(interaction.value || ''))})`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applySelectValueById(page, ${toLiteral(String(value))}, ${toLiteral(String(interaction.value || ''))}, ${toLiteral(selectorType)})`)
    }
  } else if (interactionType === 'assert') {
    if (target.url) {
      const expectedUrl = interaction.value ?? target.url
      lines.push(`await expect(page).toHaveURL(${toLiteral(String(expectedUrl))})`)
    } else {
      if (!target.testid && !target.id && !target['data-id']) {
        throw new Error(`Step "${step.id}" has interaction type "assert" but no target.testid, target.id, target.data-id, or target.url.`)
      }

      if (interaction.value == null && target.value != null) {
        throw new Error(
          `Step "${step.id}" has misplaced assert value. Put "value" under "interaction", not under "interaction.target".`
        )
      }

      const expectedValue = interaction.value ?? ''
      if (target.testid) {
        lines.push(`await assertElementValueByTestId(page, ${toLiteral(String(target.testid))}, ${toLiteral(String(expectedValue))})`)
      } else {
        const selectorType = target['data-id'] ? 'data-id' : 'id'
        const value = target['data-id'] || target.id
        lines.push(`await assertElementValueById(page, ${toLiteral(String(value))}, ${toLiteral(String(expectedValue))}, ${toLiteral(selectorType)})`)
      }
    }
  } else if (interactionType === 'search-and-select') {
    if (!target['data-id']) {
      throw new Error(`Step "${step.id}" has interaction type "search-and-select" but no target.data-id.`)
    }
    if (!interaction.value) {
      throw new Error(`Step "${step.id}" has interaction type "search-and-select" but no value.`)
    }
    if (!interaction.resultSelector) {
      throw new Error(`Step "${step.id}" has interaction type "search-and-select" but no resultSelector.`)
    }
    const dataId = String(target['data-id'])
    const value = String(interaction.value)
    const resultSelector = String(interaction.resultSelector)
    const resultIndex = interaction.resultIndex != null ? Number(interaction.resultIndex) : 0
    lines.push(`await searchAndSelect(page, { target: { 'data-id': ${toLiteral(dataId)} }, value: ${toLiteral(value)}, resultSelector: ${toLiteral(resultSelector)}, resultIndex: ${resultIndex} })`)
    // Assertion falls vorhanden
    if (interaction.assert) {
      lines.push(...buildExpectedResultAssertions([interaction.assert]))
    }
    return lines

  } else if (interactionType === 'extract-pdf-code') {
    // Custom interaction: extract code from PDF and assign to variable
    const pdfPath = interaction.pdfPath
    const regex = interaction.regex
    const output = interaction.output || 'extractedCode'
    if (!pdfPath || !regex) {
      throw new Error(`Step "${step.id}" with type extract-pdf-code requires pdfPath and regex.`)
    }
    lines.push(`const effectiveDownload = lastDownload ?? await page.waitForEvent('download', { timeout: 5000 }).catch(() => null)`)
    lines.push(`const effectivePdfResponse = lastPdfResponse ?? await page.waitForResponse((response) => String(response.headers()['content-type'] || '').includes('application/pdf'), { timeout: 5000 }).catch(() => null)`)
    lines.push(`const extractedValue = await extractCodeFromPdf(resolveRuntimeTemplateString(${toLiteral(String(pdfPath))}, runtimeVariables), new RegExp(resolveRuntimeTemplateString(${toLiteral(String(regex))}, runtimeVariables)), { download: effectiveDownload, response: effectivePdfResponse })`)
    lines.push(`setRuntimeVariable(runtimeVariables, ${toLiteral(String(output))}, extractedValue)`)
  } else if (interactionType === 'set-runtime-variable') {
    const output = interaction.output
    if (!output) {
      throw new Error(`Step "${step.id}" with type set-runtime-variable requires output.`)
    }
    lines.push(`setRuntimeVariable(runtimeVariables, ${toLiteral(String(output))}, resolveRuntimeTemplateString(${toLiteral(String(interaction.value ?? ''))}, runtimeVariables))`)
  } else {
    throw new Error(`Unsupported interaction type "${interactionType}" in step "${step.id}".`)
  }

  return lines
}

export function renderScenarioSpecTemplate({ resolvedRoot, scenarioPathRelative, envFillStrategiesImportPath = null }) {
  const flow = Array.isArray(resolvedRoot?.flow) ? resolvedRoot.flow : []
  if (!flow.length) {
    throw new Error('Scenario contains no flow steps.')
  }

  const scenarioName = String(resolvedRoot.id || basename(scenarioPathRelative))
  const scenarioVersion = String(resolvedRoot.version || 'unknown')
  const waitBetweenStepsMs = Number(resolvedRoot?.video?.wait_between_steps ?? 0)
  const describeTitle = `Scenario: ${scenarioName}`
  const testTitle = `runs generated flow for ${scenarioName}`

  const parts = []
  
  // Add all base template parts (functions and utilities)
  parts.push(...getAllTemplateParts(envFillStrategiesImportPath))

  // Add describe and test start
  parts.push('')
  parts.push(`test.describe(${toLiteral(describeTitle)}, () => {`)
  parts.push(`  test(${toLiteral(testTitle)}, async ({ page }, testInfo) => {`)
  parts.push('    const videoModeEnabled = process.env.SCENARIO_VIDEO_MODE === "1"')
  parts.push(`    const waitBetweenStepsMs = ${Number.isFinite(waitBetweenStepsMs) ? Math.max(0, Math.floor(waitBetweenStepsMs)) : 0}`)
  parts.push('    const runtimeVariables = {}')
  parts.push('    let lastDownload = null')
  parts.push('    let lastPdfResponse = null')
  parts.push('    page.on("download", (download) => { lastDownload = download })')
  parts.push('    page.on("response", (response) => {')
  parts.push('      if (String(response.headers()["content-type"] || "").includes("application/pdf")) {')
  parts.push('        lastPdfResponse = response')
  parts.push('      }')
  parts.push('    })')
  parts.push('    const timelineRuntime = createScenarioTimelineRuntime({')
  parts.push('      test,')
  parts.push('      testInfo,')
  parts.push(`      scenarioId: ${toLiteral(scenarioName)},`)
  parts.push(`      scenarioVersion: ${toLiteral(scenarioVersion)},`)
  parts.push(`      scenarioSource: ${toLiteral(String(scenarioPathRelative))},`)
  parts.push('    })')
  parts.push('')
  parts.push('    try {')

  for (const step of flow) {
    const stepId = String(step.id || slugify(step.didactics?.purpose?.text || 'step'))
    const stepTitle = step.didactics?.purpose?.text
      ? `${stepId}: ${String(step.didactics.purpose.text).replace(/\s+/g, ' ').trim()}`
      : stepId

    const ifConditions = toConditionList(step.if, 'if', stepId)
    const ifNotConditions = toConditionList(step.ifnot, 'ifnot', stepId)

    parts.push(`    await timelineRuntime.runStep(${toLiteral(stepId)}, async () => {`)
    parts.push(`      // ${stepTitle}`)

    if (ifConditions.length > 0 || ifNotConditions.length > 0) {
      parts.push(`      const shouldRunStep = await shouldRunStepFromGuards(page, ${toLiteral({ if: ifConditions, ifnot: ifNotConditions })})`)
      parts.push('      if (!shouldRunStep) {')
      parts.push("        return { __scenarioStepStatus: 'skipped', reason: 'if/ifnot guard condition not met' }")
      parts.push('      }')
      parts.push('')
    }

    const interactionLines = buildInteractionLines(step)
    for (const line of interactionLines) {
      parts.push(`      ${line}`)
    }

    const assertionLines = buildExpectedResultAssertions(step.expected_results)
    for (const line of assertionLines) {
      parts.push(`      ${line}`)
    }

    parts.push('    })')
    parts.push('')
    parts.push('    if (videoModeEnabled && waitBetweenStepsMs > 0) {')
    parts.push('      await page.waitForTimeout(waitBetweenStepsMs)')
    parts.push('    }')
    parts.push('')
  }

  parts.push('    } finally {')
  parts.push('      await timelineRuntime.flush()')
  parts.push('    }')
  parts.push('  })')
  parts.push('})')
  parts.push('')

  return parts.join('\n')
}
