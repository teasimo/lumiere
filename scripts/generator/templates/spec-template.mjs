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
