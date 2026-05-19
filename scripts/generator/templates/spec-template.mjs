import { basename } from 'path'

function slugify(input) {
  return String(input || 'scenario')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'scenario'
}

function toLiteral(value) {
  return JSON.stringify(value)
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
    if (!target.testid && !target.id && !target['data-id']) {
      throw new Error(`Step "${step.id}" has interaction type "fill" but no target.testid, target.id, or target.data-id.`)
    }
    if (interaction.value == null && target.value != null) {
      throw new Error(
        `Step "${step.id}" has misplaced fill value. Put "value" under "interaction", not under "interaction.target".`
      )
    }
    if (target.testid) {
      lines.push(`await applyFillValue(page, ${toLiteral(String(target.testid))}, ${toLiteral(String(interaction.value || ''))})`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyFillValueById(page, ${toLiteral(String(value))}, ${toLiteral(String(interaction.value || ''))}, ${toLiteral(selectorType)})`)
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
    if (!target.testid && !target.id && !target['data-id']) {
      throw new Error(`Step "${step.id}" has interaction type "click" but no target.testid, target.id, or target.data-id.`)
    }
    if (target.testid) {
      lines.push(`await page.getByTestId(${toLiteral(String(target.testid))}).click()`)
    } else {
      const selector = target['data-id'] ? `[data-id=${JSON.stringify(String(target['data-id']))}]` : `[id=${JSON.stringify(String(target.id))}]`
      lines.push(`await page.locator(${toLiteral(selector)}).first().click()`)
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
  parts.push("import { test, expect } from '@playwright/test'")
  parts.push("import { createScenarioTimelineRuntime } from '../../tests/e2e/support/generated-scenario-runtime.js'")
  parts.push("import { centralFillStrategies } from '../../scripts/generator/central-fill-strategies.mjs'")
  parts.push('')
  parts.push(`const ENV_FILL_STRATEGIES_IMPORT = ${toLiteral(envFillStrategiesImportPath)}`)
  parts.push('let fillStrategiesCache')
  parts.push('')
  parts.push('async function loadEnvFillStrategies() {')
  parts.push('  if (fillStrategiesCache) {')
  parts.push('    return fillStrategiesCache')
  parts.push('  }')
  parts.push('')
  parts.push('  const strategies = []')
  parts.push('')
  parts.push('  // Load app-specific strategies first (higher priority)')
  parts.push('  if (ENV_FILL_STRATEGIES_IMPORT) {')
  parts.push('    try {')
  parts.push('      const module = await import(ENV_FILL_STRATEGIES_IMPORT)')
  parts.push('      const exported = module?.fillStrategies ?? module?.default ?? []')
  parts.push('      if (Array.isArray(exported)) {')
  parts.push('        strategies.push(...exported)')
  parts.push('      }')
  parts.push('    } catch (error) {')
  parts.push('      console.warn(`Could not load app-specific fill strategies from ${ENV_FILL_STRATEGIES_IMPORT}: ${error.message}`)')
  parts.push('    }')
  parts.push('  }')
  parts.push('')
  parts.push('  // Load central strategies as fallback')
  parts.push('  if (Array.isArray(centralFillStrategies)) {')
  parts.push('    strategies.push(...centralFillStrategies)')
  parts.push('  }')
  parts.push('')
  parts.push('  fillStrategiesCache = strategies')
  parts.push('  return fillStrategiesCache')
  parts.push('}')
  parts.push('')
  parts.push('async function readValueFromElement(locator, elementInfo) {')
  parts.push("  if (elementInfo.tagName === 'input' || elementInfo.tagName === 'textarea') {")
  parts.push('    return locator.inputValue()')
  parts.push('  }')
  parts.push('')
  parts.push('  if (elementInfo.isContentEditable) {')
  parts.push('    return locator.evaluate((el) => el.textContent || "")')
  parts.push('  }')
  parts.push('')
  parts.push('  return locator.evaluate((el) => el.getAttribute("value") ?? "")')
  parts.push('}')
  parts.push('')
  parts.push('async function assertFillPersisted(locator, elementInfo, testId, expectedValue) {')
  parts.push('  const currentValue = await readValueFromElement(locator, elementInfo)')
  parts.push('  if (currentValue !== expectedValue) {')
  parts.push('    throw new Error(`Fill did not persist for data-testid="${testId}". Expected "${expectedValue}", got "${currentValue}".`)')
  parts.push('  }')
  parts.push('}')
  parts.push('')
  parts.push('async function applyDefaultFillStrategy(page, locator, expectedValue, elementInfo, testId, mode = "fill") {')
  parts.push("  if (elementInfo.tagName === 'input' || elementInfo.tagName === 'textarea') {")
  parts.push('    await locator.click()')
  parts.push("    if (mode === 'append') {")
  parts.push("      await locator.press('End')")
  parts.push('    } else {')
  parts.push("      await locator.press('Control+a')")
  parts.push("      await locator.press('Backspace')")
  parts.push('    }')
  parts.push('    if (expectedValue) {')
  parts.push('      await locator.type(expectedValue, { delay: 35 })')
  parts.push('    }')
  parts.push('    await locator.dispatchEvent("input")')
  parts.push('    await locator.dispatchEvent("change")')
  parts.push("    await locator.press('Tab')")
  parts.push('    await assertFillPersisted(locator, elementInfo, testId, expectedValue)')
  parts.push('    return')
  parts.push('  }')
  parts.push('')
  parts.push('  if (elementInfo.isContentEditable) {')
  parts.push('    await locator.click()')
  parts.push("    await page.keyboard.press('Control+a')")
  parts.push('    if (expectedValue) {')
  parts.push('      await locator.type(expectedValue, { delay: 35 })')
  parts.push('    } else {')
  parts.push("      await page.keyboard.press('Backspace')")
  parts.push('    }')
  parts.push('    await locator.dispatchEvent("input")')
  parts.push('    await locator.dispatchEvent("change")')
  parts.push('    await assertFillPersisted(locator, elementInfo, testId, expectedValue)')
  parts.push('    return')
  parts.push('  }')
  parts.push('')
  parts.push('  throw new Error(')
  parts.push('    `Fill is not supported for data-testid="${testId}" (<${elementInfo.tagName || "unknown"}>) because it is neither input/textarea nor contenteditable.`')
  parts.push('  )')
  parts.push('}')
  parts.push('')
  parts.push('async function applyFillValue(page, testId, value) {')
  parts.push('  const locator = page.getByTestId(testId).first()')
  parts.push("  await locator.waitFor({ state: 'visible' })")
  parts.push('')
  parts.push('  const elementInfo = await locator.evaluate((el) => ({')
  parts.push("    tagName: el.tagName?.toLowerCase?.() || '',")
  parts.push('    isContentEditable: Boolean(el.isContentEditable),')
  parts.push('    className: String(el.className || ""),')
  parts.push('    modelValue: el.getAttribute("model-value"),')
  parts.push('    role: el.getAttribute("role"),')
  parts.push('  }))')
  parts.push('')
  parts.push('  const expectedValue = String(value ?? "")')
  parts.push('')
  parts.push('  const envStrategies = await loadEnvFillStrategies()')
  parts.push('  for (const strategy of envStrategies) {')
  parts.push('    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const isMatch = await strategy.match({ testId, elementInfo, expectedValue })')
  parts.push('    if (!isMatch) {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const result = await strategy.run({ page, locator, testId, elementInfo, expectedValue })')
  parts.push('    const handled = typeof result === "object" && result !== null')
  parts.push('      ? Boolean(result.handled)')
  parts.push('      : Boolean(result)')
  parts.push('')
  parts.push('    if (handled) {')
  parts.push('      const skipVerification = typeof result === "object" && result !== null && result.verify === false')
  parts.push('      if (!skipVerification) {')
  parts.push('        await assertFillPersisted(locator, elementInfo, testId, expectedValue)')
  parts.push('      }')
  parts.push('      return')
  parts.push('    }')
  parts.push('  }')
  parts.push('')
  parts.push('  await applyDefaultFillStrategy(page, locator, expectedValue, elementInfo, testId)')
  parts.push('}')
  parts.push('')
  parts.push('async function applyFillValueById(page, elementId, value, selectorType = "id") {')
  parts.push('  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`')
  parts.push('  const locator = page.locator(selector).first()')
  parts.push("  await locator.waitFor({ state: 'visible' })")
  parts.push('')
  parts.push('  const elementInfo = await locator.evaluate((el) => ({')
  parts.push("    tagName: el.tagName?.toLowerCase?.() || '',")
  parts.push('    isContentEditable: Boolean(el.isContentEditable),')
  parts.push('    className: String(el.className || ""),')
  parts.push('    modelValue: el.getAttribute("model-value"),')
  parts.push('    role: el.getAttribute("role"),')
  parts.push('  }))')
  parts.push('')
  parts.push('  const expectedValue = String(value ?? "")')
  parts.push('')
  parts.push('  const envStrategies = await loadEnvFillStrategies()')
  parts.push('  for (const strategy of envStrategies) {')
  parts.push('    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const isMatch = await strategy.match({ testId: elementId, elementInfo, expectedValue })')
  parts.push('    if (!isMatch) {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const result = await strategy.run({ page, locator, testId: elementId, elementInfo, expectedValue })')
  parts.push('    const handled = typeof result === "object" && result !== null')
  parts.push('      ? Boolean(result.handled)')
  parts.push('      : Boolean(result)')
  parts.push('')
  parts.push('    if (handled) {')
  parts.push('      const skipVerification = typeof result === "object" && result !== null && result.verify === false')
  parts.push('      if (!skipVerification) {')
  parts.push('        await assertFillPersisted(locator, elementInfo, `#${elementId}`, expectedValue)')
  parts.push('      }')
  parts.push('      return')
  parts.push('    }')
  parts.push('  }')
  parts.push('')
  parts.push('  await applyDefaultFillStrategy(page, locator, expectedValue, elementInfo, `#${elementId}`)')
  parts.push('}')
  parts.push('')
  parts.push('async function applySelectValue(page, testId, value) {')
  parts.push('  const locator = page.getByTestId(testId).first()')
  parts.push("  await locator.waitFor({ state: 'visible' })")
  parts.push('')
  parts.push('  const elementInfo = await locator.evaluate((el) => ({')
  parts.push("    tagName: el.tagName?.toLowerCase?.() || '',")
  parts.push("    className: String(el.className || ''),")
  parts.push("    role: el.getAttribute('role'),")
  parts.push("    ariaHasPopup: el.getAttribute('aria-haspopup'),")
  parts.push('  }))')
  parts.push('')
  parts.push("  const expectedValue = String(value ?? '')")
  parts.push('')
  parts.push('  const envStrategies = await loadEnvFillStrategies()')
  parts.push('  for (const strategy of envStrategies) {')
  parts.push('    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const isMatch = await strategy.match({ testId, elementInfo, expectedValue, isSelect: true })')
  parts.push('    if (!isMatch) {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const result = await strategy.run({ page, locator, testId, elementInfo, expectedValue, isSelect: true })')
  parts.push('    const handled = typeof result === "object" && result !== null')
  parts.push('      ? Boolean(result.handled)')
  parts.push('      : Boolean(result)')
  parts.push('')
  parts.push('    if (handled) {')
  parts.push('      return')
  parts.push('    }')
  parts.push('  }')
  parts.push('')
  parts.push('  throw new Error(`No select strategy found for data-testid="${testId}". Add a strategy to env/fill-strategies.mjs for this component.`)')
  parts.push('}')
  parts.push('')
  parts.push('async function applySelectValueById(page, elementId, value, selectorType = "id") {')
  parts.push('  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`')
  parts.push('  const locator = page.locator(selector).first()')
  parts.push("  await locator.waitFor({ state: 'visible' })")
  parts.push('')
  parts.push('  const elementInfo = await locator.evaluate((el) => ({')
  parts.push("    tagName: el.tagName?.toLowerCase?.() || '',")
  parts.push("    className: String(el.className || ''),")
  parts.push("    role: el.getAttribute('role'),")
  parts.push("    ariaHasPopup: el.getAttribute('aria-haspopup'),")
  parts.push('  }))')
  parts.push('')
  parts.push("  const expectedValue = String(value ?? '')")
  parts.push('')
  parts.push('  const envStrategies = await loadEnvFillStrategies()')
  parts.push('  for (const strategy of envStrategies) {')
  parts.push('    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const isMatch = await strategy.match({ testId: elementId, elementInfo, expectedValue, isSelect: true })')
  parts.push('    if (!isMatch) {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const result = await strategy.run({ page, locator, testId: elementId, elementInfo, expectedValue, isSelect: true })')
  parts.push('    const handled = typeof result === "object" && result !== null')
  parts.push('      ? Boolean(result.handled)')
  parts.push('      : Boolean(result)')
  parts.push('')
  parts.push('    if (handled) {')
  parts.push('      return')
  parts.push('    }')
  parts.push('  }')
  parts.push('')
  parts.push('  throw new Error(`No select strategy found for id="#${elementId}". Add a strategy to env/fill-strategies.mjs for this component.`)')
  parts.push('}')
  parts.push('')
  parts.push('async function applyAppendValue(page, testId, value) {')
  parts.push('  const locator = page.getByTestId(testId).first()')
  parts.push("  await locator.waitFor({ state: 'visible' })")
  parts.push('')
  parts.push('  const elementInfo = await locator.evaluate((el) => ({')
  parts.push("    tagName: el.tagName?.toLowerCase?.() || '',")
  parts.push('    isContentEditable: Boolean(el.isContentEditable),')
  parts.push('    className: String(el.className || ""),')
  parts.push('    modelValue: el.getAttribute("model-value"),')
  parts.push('    role: el.getAttribute("role"),')
  parts.push('  }))')
  parts.push('')
  parts.push('  const expectedValue = String(value ?? "")')
  parts.push('')
  parts.push('  const envStrategies = await loadEnvFillStrategies()')
  parts.push('  for (const strategy of envStrategies) {')
  parts.push('    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const isMatch = await strategy.match({ testId, elementInfo, expectedValue, isAppend: true })')
  parts.push('    if (!isMatch) {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const result = await strategy.run({ page, locator, testId, elementInfo, expectedValue, isAppend: true })')
  parts.push('    const handled = typeof result === "object" && result !== null')
  parts.push('      ? Boolean(result.handled)')
  parts.push('      : Boolean(result)')
  parts.push('')
  parts.push('    if (handled) {')
  parts.push('      const skipVerification = typeof result === "object" && result !== null && result.verify === false')
  parts.push('      if (!skipVerification) {')
  parts.push('        await assertAppendPersisted(locator, elementInfo, testId, expectedValue)')
  parts.push('      }')
  parts.push('      return')
  parts.push('    }')
  parts.push('  }')
  parts.push('')
  parts.push('  await applyDefaultFillStrategy(page, locator, expectedValue, elementInfo, testId, "append")')
  parts.push('}')
  parts.push('')
  parts.push('async function applyAppendValueById(page, elementId, value, selectorType = "id") {')
  parts.push('  const selector = selectorType === "data-id" ? `[data-id=${JSON.stringify(String(elementId))}]` : `[id=${JSON.stringify(String(elementId))}]`')
  parts.push('  const locator = page.locator(selector).first()')
  parts.push("  await locator.waitFor({ state: 'visible' })")
  parts.push('')
  parts.push('  const elementInfo = await locator.evaluate((el) => ({')
  parts.push("    tagName: el.tagName?.toLowerCase?.() || '',")
  parts.push('    isContentEditable: Boolean(el.isContentEditable),')
  parts.push('    className: String(el.className || ""),')
  parts.push('    modelValue: el.getAttribute("model-value"),')
  parts.push('    role: el.getAttribute("role"),')
  parts.push('  }))')
  parts.push('')
  parts.push('  const expectedValue = String(value ?? "")')
  parts.push('')
  parts.push('  const envStrategies = await loadEnvFillStrategies()')
  parts.push('  for (const strategy of envStrategies) {')
  parts.push('    if (!strategy || typeof strategy.match !== "function" || typeof strategy.run !== "function") {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const isMatch = await strategy.match({ testId: elementId, elementInfo, expectedValue, isAppend: true })')
  parts.push('    if (!isMatch) {')
  parts.push('      continue')
  parts.push('    }')
  parts.push('')
  parts.push('    const result = await strategy.run({ page, locator, testId: elementId, elementInfo, expectedValue, isAppend: true })')
  parts.push('    const handled = typeof result === "object" && result !== null')
  parts.push('      ? Boolean(result.handled)')
  parts.push('      : Boolean(result)')
  parts.push('')
  parts.push('    if (handled) {')
  parts.push('      const skipVerification = typeof result === "object" && result !== null && result.verify === false')
  parts.push('      if (!skipVerification) {')
  parts.push('        await assertAppendPersisted(locator, elementInfo, `#${elementId}`, expectedValue)')
  parts.push('      }')
  parts.push('      return')
  parts.push('    }')
  parts.push('  }')
  parts.push('')
  parts.push('  await applyDefaultFillStrategy(page, locator, expectedValue, elementInfo, `#${elementId}`, "append")')
  parts.push('}')
  parts.push('')

  parts.push('async function assertAppendPersisted(locator, elementInfo, testId, appendedValue) {')
  parts.push('  const currentValue = await readValueFromElement(locator, elementInfo)')
  parts.push('  if (!currentValue.endsWith(appendedValue)) {')
  parts.push('    throw new Error(`Append did not persist for data-testid="${testId}". Expected suffix "${appendedValue}", got "${currentValue}".`)')
  parts.push('  }')
  parts.push('}')
  parts.push('')
  parts.push('// Auto-generated file. Do not edit manually.')
  parts.push(`// Source scenario: ${scenarioPathRelative}`)
  parts.push('')
  parts.push(`test.describe(${toLiteral(describeTitle)}, () => {`)
  parts.push(`  test(${toLiteral(testTitle)}, async ({ page }, testInfo) => {`)
  parts.push('    const videoModeEnabled = process.env.SCENARIO_VIDEO_MODE === "1"')
  parts.push(`    const waitBetweenStepsMs = ${Number.isFinite(waitBetweenStepsMs) ? Math.max(0, Math.floor(waitBetweenStepsMs)) : 0}`)
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

    parts.push(`    await timelineRuntime.runStep(${toLiteral(stepId)}, async () => {`)
    parts.push(`      // ${stepTitle}`)

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
