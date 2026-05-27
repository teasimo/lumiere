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

function countRenderedSteps(flowEntries) {
  let count = 0

  for (const step of flowEntries || []) {
    count += 1
    if (Array.isArray(step?.flow) && step.flow.length > 0) {
      count += countRenderedSteps(step.flow)
    }
  }

  return count
}

function hasUsableScrollTarget(target) {
  if (!target || typeof target !== 'object') {
    return false
  }

  if (target.testid || target.id || target['data-id'] || target.text) {
    return true
  }

  return Boolean(buildGenericTargetSelector(target))
}

function isInteractionTypeNeedingAutoScroll(interactionType) {
  return ['click', 'fill', 'append', 'select', 'search-and-select'].includes(interactionType)
}

function injectAutoScrollSteps(flowEntries, options = {}, path = []) {
  const enabled = options.enabled === true
  const injected = []

  for (let index = 0; index < (flowEntries || []).length; index += 1) {
    const step = flowEntries[index]
    const currentPath = [...path, index]
    const stepId = String(step?.id || slugify(`step-${currentPath.join('-')}`))
    const interaction = step?.interaction || {}
    const interactionType = String(interaction.type || '').trim().toLowerCase()

    if (enabled && isInteractionTypeNeedingAutoScroll(interactionType) && hasUsableScrollTarget(interaction.target)) {
      injected.push({
        id: `${stepId}__autoscroll`,
        if: step?.if,
        ifnot: step?.ifnot,
        interaction: {
          type: 'scroll',
          target: interaction.target,
          focus: false,
          only_if_not_visible: true,
        },
      })
    }

    const nestedFlow = Array.isArray(step?.flow) ? step.flow : null
    if (nestedFlow && nestedFlow.length > 0) {
      injected.push({
        ...step,
        flow: injectAutoScrollSteps(nestedFlow, options, currentPath),
      })
    } else {
      injected.push(step)
    }
  }

  return injected
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

function buildInteractionLines(step, options = {}) {
  const chapter = step?.chapter
  const chapterText = typeof chapter?.text === 'string' ? chapter.text.trim() : ''
  const hasChapter = chapter && typeof chapter === 'object' && !Array.isArray(chapter) && chapterText.length > 0
  const interaction = step.interaction || {}
  const interactionType = String(interaction.type || '').trim().toLowerCase()
  const target = interaction.target || {}
  const lines = []
  const scrollDelayRef = options.scrollDelayRef || '35'

  if (!interactionType) {
    if (hasChapter) {
      // Chapter steps intentionally emit no browser interaction. The step still
      // exists in the timeline and is post-processed into a video title card.
      lines.push('await page.waitForTimeout(10)')
      return lines
    }
    throw new Error(`Step "${step.id}" defines neither an interaction nor a supported chapter block.`)
  }

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
  } else if (interactionType === 'scroll') {
    const focus = interaction.focus === true
    const onlyIfNotVisible = interaction.only_if_not_visible === true
    if (!target.testid && !target.id && !target['data-id'] && !target.text && !buildGenericTargetSelector(target)) {
      throw new Error(`Step "${step.id}" has interaction type "scroll" but no usable target fields.`)
    }

    if (target.text) {
      if (target.role) {
        lines.push(`const __scenarioScrollResult = await scrollToLocator(page, page.getByRole(${toLiteral(String(target.role))}, { name: ${toLiteral(String(target.text))}, exact: true }).first(), { stepDelayMs: ${scrollDelayRef}, focus: ${focus ? 'true' : 'false'}, onlyIfNotVisible: ${onlyIfNotVisible ? 'true' : 'false'} })`)
      } else {
        lines.push(`const __scenarioScrollResult = await scrollToLocator(page, page.getByText(${toLiteral(String(target.text))}, { exact: true }).first(), { stepDelayMs: ${scrollDelayRef}, focus: ${focus ? 'true' : 'false'}, onlyIfNotVisible: ${onlyIfNotVisible ? 'true' : 'false'} })`)
      }
    } else if (target.testid) {
      lines.push(`const __scenarioScrollResult = await scrollToLocator(page, page.getByTestId(${toLiteral(String(target.testid))}).first(), { stepDelayMs: ${scrollDelayRef}, focus: ${focus ? 'true' : 'false'}, onlyIfNotVisible: ${onlyIfNotVisible ? 'true' : 'false'} })`)
    } else if (buildGenericTargetSelector(target)) {
      lines.push(`const __scenarioScrollResult = await scrollToLocator(page, page.locator(${toLiteral(buildGenericTargetSelector(target))}).first(), { stepDelayMs: ${scrollDelayRef}, focus: ${focus ? 'true' : 'false'}, onlyIfNotVisible: ${onlyIfNotVisible ? 'true' : 'false'} })`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      const selector = selectorType === 'data-id'
        ? `[data-id=${JSON.stringify(String(value))}]`
        : `[id=${JSON.stringify(String(value))}]`
      lines.push(`const __scenarioScrollResult = await scrollToLocator(page, page.locator(${toLiteral(selector)}).first(), { stepDelayMs: ${scrollDelayRef}, focus: ${focus ? 'true' : 'false'}, onlyIfNotVisible: ${onlyIfNotVisible ? 'true' : 'false'} })`)
    }
    lines.push('if (!__scenarioScrollResult.didScroll) {')
    lines.push(`  return { __scenarioStepStatus: 'noop', reason: 'scroll target already in view' }`)
    lines.push('}')
  } else if (interactionType === 'wait') {
    const hasConditionTarget = target && typeof target === 'object' && Object.keys(target).length > 0
    const hasUntilCondition = interaction.until && typeof interaction.until === 'object' && !Array.isArray(interaction.until)
    const durationCandidate = interaction.ms ?? interaction.value ?? (!hasConditionTarget && !hasUntilCondition ? interaction.wait_ms : null)

    if (durationCandidate != null) {
      const durationMs = Number(durationCandidate)
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(`Step "${step.id}" has interaction type "wait" with invalid duration. Use interaction.ms as a non-negative number.`)
      }
      lines.push(`await page.waitForTimeout(${Math.floor(durationMs)})`)
    }

    const untilCondition = hasUntilCondition
      ? interaction.until
      : (hasConditionTarget ? { target, state: interaction.state || target.state || {} } : null)

    if (untilCondition) {
      const timeoutCandidate = interaction.timeout_ms ?? interaction.wait_until_timeout_ms ?? interaction.wait_ms ?? untilCondition?.state?.wait_ms ?? 5000
      const pollCandidate = interaction.poll_ms ?? 100
      const timeoutMs = Number(timeoutCandidate)
      const pollMs = Number(pollCandidate)

      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(`Step "${step.id}" has interaction type "wait" with invalid timeout_ms.`)
      }

      if (!Number.isFinite(pollMs) || pollMs <= 0) {
        throw new Error(`Step "${step.id}" has interaction type "wait" with invalid poll_ms.`)
      }

      lines.push(`await waitForCondition(page, ${toLiteral(untilCondition)}, ${Math.floor(timeoutMs)}, ${Math.max(25, Math.floor(pollMs))})`)
    }

    if (durationCandidate == null && !untilCondition) {
      throw new Error(`Step "${step.id}" has interaction type "wait" but no waiting criteria. Use interaction.ms and/or interaction.target with interaction.state (or interaction.until).`)
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
  const baseFlow = Array.isArray(resolvedRoot?.flow) ? resolvedRoot.flow : []
  const autoScrollSmoothEnabled = resolvedRoot?.video?.autoscroll_smooth === true
  const flow = injectAutoScrollSteps(baseFlow, { enabled: autoScrollSmoothEnabled })
  if (!flow.length) {
    throw new Error('Scenario contains no flow steps.')
  }

  const scenarioName = String(resolvedRoot.id || basename(scenarioPathRelative))
  const scenarioVersion = String(resolvedRoot.version || 'unknown')
  const stepIdentifierLogEnabledByScenario = resolvedRoot?.debug?.log_step_identifiers === true
  const waitBetweenStepsMs = Number(resolvedRoot?.video?.wait_between_steps ?? 0)
  const scrollDelayMs = Number(resolvedRoot?.video?.scroll_delay_ms ?? 35)
  const renderedStepCount = Math.max(1, countRenderedSteps(flow))
  const actionBudgetMs = renderedStepCount * 3500
  const pacingBudgetMs = renderedStepCount * Math.max(0, Math.floor(waitBetweenStepsMs))
  const dynamicTestTimeoutMs = Math.max(30000, actionBudgetMs + pacingBudgetMs + 10000)
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
  parts.push(`    test.setTimeout(${dynamicTestTimeoutMs})`)
  parts.push(`    const waitBetweenStepsMs = ${Number.isFinite(waitBetweenStepsMs) ? Math.max(0, Math.floor(waitBetweenStepsMs)) : 0}`)
  parts.push(`    const scrollDelayMs = ${Number.isFinite(scrollDelayMs) ? Math.max(0, Math.floor(scrollDelayMs)) : 35}`)
  parts.push(`    const stepIdentifierLogEnabledByScenario = ${stepIdentifierLogEnabledByScenario ? 'true' : 'false'}`)
  parts.push('    const stepIdentifierLogEnabledByEnv = process.env.SCENARIO_STEP_DOM_LOG === "1" || process.env.SCENARIO_STEP_DOM_LOG === "true"')
  parts.push('    const stepIdentifierLogEnabled = stepIdentifierLogEnabledByScenario || stepIdentifierLogEnabledByEnv')
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
  parts.push('    const stepIdentifierLogger = createStepDomIdentifierLogger({ page, testInfo, enabled: stepIdentifierLogEnabled })')
  parts.push('')
  parts.push('    try {')
  parts.push('      let __scenarioStepResult = null')
  parts.push('      let __scenarioShouldWaitAfterStep = true')

  function emitFlowSteps(steps, indent = '    ') {
    for (const step of steps) {
      const stepDidactics = step?.didactics || step?.didactic || {}
      const purposeText = typeof stepDidactics?.purpose?.text === 'string'
        ? String(stepDidactics.purpose.text).replace(/\s+/g, ' ').trim()
        : ''
      const stepId = String(step.id || slugify(purposeText || 'step'))
      const stepTitle = purposeText ? `${stepId}: ${purposeText}` : stepId

      const ifConditions = toConditionList(step.if, 'if', stepId)
      const ifNotConditions = toConditionList(step.ifnot, 'ifnot', stepId)

      parts.push(`${indent}__scenarioStepResult = await timelineRuntime.runStep(${toLiteral(stepId)}, async () => {`)
      parts.push(`${indent}  // ${stepTitle}`)
      parts.push(`${indent}  await stepIdentifierLogger.capture(${toLiteral(stepId)}, "before")`)

      if (ifConditions.length > 0 || ifNotConditions.length > 0) {
        parts.push(`${indent}  const shouldRunStep = await shouldRunStepFromGuards(page, ${toLiteral({ if: ifConditions, ifnot: ifNotConditions })})`)
        parts.push(`${indent}  if (!shouldRunStep) {`)
        parts.push(`${indent}    await stepIdentifierLogger.capture(${toLiteral(stepId)}, "skipped", { reason: "if/ifnot guard condition not met" })`)
        parts.push(`${indent}    return { __scenarioStepStatus: 'skipped', reason: 'if/ifnot guard condition not met' }`)
        parts.push(`${indent}  }`)
        parts.push('')
      }

      const nestedFlow = Array.isArray(step.flow) ? step.flow : []
      if (nestedFlow.length > 0) {
        emitFlowSteps(nestedFlow, `${indent}  `)
      } else {
        const interactionLines = buildInteractionLines(step, { scrollDelayRef: 'scrollDelayMs' })
        for (const line of interactionLines) {
          parts.push(`${indent}  ${line}`)
        }

        const assertionLines = buildExpectedResultAssertions(step.expected_results)
        for (const line of assertionLines) {
          parts.push(`${indent}  ${line}`)
        }
      }

      parts.push(`${indent}  await stepIdentifierLogger.capture(${toLiteral(stepId)}, "after")`)
      parts.push(`${indent}})`)
      parts.push('')
      parts.push(`${indent}__scenarioShouldWaitAfterStep = !(__scenarioStepResult && typeof __scenarioStepResult === 'object' && (__scenarioStepResult.__scenarioStepStatus === 'skipped' || __scenarioStepResult.__scenarioStepStatus === 'noop'))`)
      parts.push(`${indent}if (videoModeEnabled && waitBetweenStepsMs > 0 && __scenarioShouldWaitAfterStep) {`)
      parts.push(`${indent}  await page.waitForTimeout(waitBetweenStepsMs)`)
      parts.push(`${indent}}`)
      parts.push('')
    }
  }

  emitFlowSteps(flow, '    ')

  parts.push('    } finally {')
  parts.push('      await stepIdentifierLogger.flush()')
  parts.push('      await timelineRuntime.flush()')
  parts.push('    }')
  parts.push('  })')
  parts.push('})')
  parts.push('')

  return parts.join('\n')
}
