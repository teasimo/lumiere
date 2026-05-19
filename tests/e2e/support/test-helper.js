import { expect } from '@playwright/test'
import { getRegisteredInteraction } from '../page-interactions/interaction-registry.js'

export const ROOT_URL = process.env.ROOT_URL || process.env.PLAYWRIGHT_ROOT_URL || 'http://127.0.0.1:5174/app'
export const E2E_USERNAME = process.env.E2E_USERNAME || 'schulte'
export const E2E_PASSWORD = process.env.E2E_PASSWORD || 'test'



export function buildRunId(testInfo) {
  return [
	new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17),
	`w${testInfo.workerIndex}`,
	`r${testInfo.repeatEachIndex}`,
	Math.random().toString(36).slice(2, 8)
  ].join('-')
}	

export function createUiTestApi(page, options = {}) {
  const isDemoMode = options.demo === true
  const defaultOutcomeByVerb = {
    fill: 'valueUpdated',
    append: 'valueAppended',
    read: 'ready',
    ensure: 'ready',
    clickByText: 'clicked',
    clickRow: 'ready',
  }

  async function maybeDemoWait() {
    if (isDemoMode) {
      await page.waitForTimeout(500)
    }
  }

  async function readTargetText(target) {
    return target.evaluate((el) => {
      const tagName = el.tagName?.toLowerCase?.() || ''
      // input/textarea: .value liefert den rohen Text inkl. Zeilenumbruechen.
      // toContainText() wuerde hier scheitern, weil Playwright den DOM-Text
      // liest und Whitespace normalisiert - Zeilenumbrueche gehen verloren.
      if (tagName === 'input' || tagName === 'textarea') return String(el.value ?? '')
      if (el.isContentEditable) {
        // CodeMirror rendert den Inhalt als virtuellen DOM; innerText/textContent
        // enthalten nur den sichtbaren Ausschnitt, nicht den gesamten Dokumenttext.
        // Ueber die interne cm-editor-Instanz (cmView.view.state.doc) bekommen wir
        // den vollstaendigen, rohen Editorinhalt mit allen Zeilenumbruechen.
        const root = el.closest('.cm-editor')
        const docText = root?.cmView?.view?.state?.doc?.toString?.()
        if (typeof docText === 'string') return docText
        // Fallback falls die CodeMirror-API nicht verfuegbar ist.
        return String(el.innerText ?? el.textContent ?? '')
      }
      // Fuer alle anderen Elemente reicht textContent.
      return String(el.textContent ?? '')
    })
  }

  function describeOutcomeExpectation(resolvedTarget, description) {
    return `Outcome check failed for data-testid="${resolvedTarget}": expected ${description}`
  }

  function resolveOutcomeTargetTestId(outcome, params = {}) {
    return outcome.targetFromParam
      ? String(params[outcome.targetFromParam] ?? '')
      : String(outcome.target ?? '')
  }

  async function readNotificationProbeSnapshot() {
    const notificationProbe = page.getByTestId('app-notification-probe').first()
    const seqRaw = await notificationProbe.getAttribute('data-feedback-seq')
    const kind = await notificationProbe.getAttribute('data-feedback-kind')
    const seq = Number(seqRaw ?? '0')
    return {
      seq: Number.isFinite(seq) ? seq : 0,
      kind: String(kind ?? ''),
    }
  }

  async function assertOutcome(outcome, params = {}) {
    const resolvedTarget = resolveOutcomeTargetTestId(outcome, params)

    if (!resolvedTarget) {
      throw new Error('Outcome target is missing. Use "target" or "targetFromParam".')
    }

    const target = page.getByTestId(resolvedTarget).first()

    if (outcome.state) {
      await expect(
        target,
        describeOutcomeExpectation(resolvedTarget, `data-state="${outcome.state}"`)
      ).toHaveAttribute('data-state', outcome.state)
    }

    if (outcome.stateCycle) {
      const activeState = String(outcome.stateCycle.active ?? 'loading')
      const doneState = String(outcome.stateCycle.done ?? 'idle')
      const timeoutMs = Number(outcome.stateCycle.timeoutMs ?? 15000)
      let hasSeenActiveState = false

      await expect(async () => {
        const currentState = String(await target.getAttribute('data-state') ?? '')
        if (currentState === activeState) {
          hasSeenActiveState = true
          throw new Error(`Still in active state \"${activeState}\"`)
        }

        if (!hasSeenActiveState) {
          throw new Error(`Active state \"${activeState}\" not observed yet`)
        }

        expect(currentState).toBe(doneState)
      }, describeOutcomeExpectation(
        resolvedTarget,
        `state cycle ${activeState} -> ${doneState}`
      )).toPass({ timeout: timeoutMs })
    }

    if (outcome.visible === true) {
      await expect(
        target,
        describeOutcomeExpectation(resolvedTarget, 'element to be visible')
      ).toBeVisible()
    }

    if (outcome.visible === false) {
      await expect(
        target,
        describeOutcomeExpectation(resolvedTarget, 'element to be hidden')
      ).toBeHidden()
    }

    if (outcome.detached === true) {
      // Wartet darauf, dass das Element vollständig aus dem DOM entfernt ist (nicht nur
      // CSS-unsichtbar). Wichtig bei Quasar-Dialogen mit Teleport: während der
      // Schliess-Animation ist das Element bereits hidden, aber noch im DOM. Ohne diesen
      // Check kann ein nachfolgender getByTestId-Aufruf noch die alte Instanz treffen.
      await expect(
        target,
        describeOutcomeExpectation(resolvedTarget, 'element to be detached from DOM')
      ).toBeAttached({ attached: false })
    }

    if (outcome.text) {
      const expectedText = String(outcome.text ?? '')
      await expect(async () => {
        const actualText = await readTargetText(target)
        expect(actualText).toContain(expectedText)
      }, describeOutcomeExpectation(resolvedTarget, `text to contain ${JSON.stringify(expectedText)}`)).toPass()
    }

    if (outcome.textFromParam) {
      const expectedText = String(params[outcome.textFromParam] ?? '')
      await expect(async () => {
        const actualText = await readTargetText(target)
        expect(actualText).toContain(expectedText)
      }, describeOutcomeExpectation(resolvedTarget, `text to contain param ${outcome.textFromParam}=${JSON.stringify(expectedText)}`)).toPass()
    }

    if (outcome.valueFromParam) {
      const expectedValue = String(params[outcome.valueFromParam] ?? '')
      await expect(
        target,
        describeOutcomeExpectation(resolvedTarget, `value to equal ${JSON.stringify(expectedValue)}`)
      ).toHaveValue(expectedValue)
    }

    if (outcome.successNotification) {
      const notificationProbe = page.getByTestId('app-notification-probe').first()
      await expect(
        notificationProbe,
        'Outcome check failed for data-testid="app-notification-probe": expected data-feedback-kind="success"'
      ).toHaveAttribute('data-feedback-kind', 'success')
    }

    if (outcome.successNotificationSinceAction) {
      const seqBefore = Number(params.notificationSeqBefore ?? 0)
      const notificationProbe = page.getByTestId('app-notification-probe').first()

      await expect(async () => {
        const seqRaw = await notificationProbe.getAttribute('data-feedback-seq')
        const kind = String(await notificationProbe.getAttribute('data-feedback-kind') ?? '')
        const seq = Number(seqRaw ?? '0')

        expect(Number.isFinite(seq) ? seq : 0).toBeGreaterThan(seqBefore)
        expect(kind).toBe('success')
      }, 'Outcome check failed for data-testid="app-notification-probe": expected a new success notification after this action').toPass()
    }

  }

  function normalizeExecutionOptions(input, fallbackKey) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return { ...input }
    }

    if (input === undefined) {
      return {}
    }

    return { [fallbackKey]: input }
  }

  function resolveInteraction(verb, trigger) {
    const normalizedTrigger = String(trigger ?? '').trim()
    if (!normalizedTrigger) {
      throw new Error(`Missing trigger for ${verb} interaction`)
    }

    const interaction = getRegisteredInteraction(verb, normalizedTrigger)
    if (!interaction) {
      throw new Error(`Unknown ${verb} interaction for trigger "${normalizedTrigger}"`)
    }

    return interaction
  }

  function resolveOutcome(interaction, verb, requestedOutcome) {
    const outcomeName = requestedOutcome
      ?? interaction.defaultOutcome
      ?? defaultOutcomeByVerb[verb]

    if (!outcomeName) {
      throw new Error(`No default outcome configured for ${verb} interaction "${interaction.trigger}"`)
    }

    const outcome = interaction.outcomes?.[outcomeName]
    if (!outcome) {
      throw new Error(`Unknown outcome "${outcomeName}" for ${verb} interaction "${interaction.trigger}"`)
    }

    return outcome
  }

  return {
    async fill(trigger, value, options) {
      await maybeDemoWait()

      const interaction = resolveInteraction('fill', trigger)
      const executionOptions = normalizeExecutionOptions(options, 'outcome')
      const outcome = resolveOutcome(interaction, 'fill', executionOptions.outcome)

      const target = page.getByTestId(interaction.trigger).first()
      const elementInfo = await target.evaluate((el) => ({
        tagName: el.tagName?.toLowerCase?.() || '',
        isContentEditable: Boolean(el.isContentEditable),
      }))

      if (elementInfo.tagName === 'input' || elementInfo.tagName === 'textarea') {
        await target.fill(String(value ?? ''))
      } else if (elementInfo.isContentEditable) {
        await target.click()
        await page.keyboard.press('Control+a')
        await page.keyboard.insertText(String(value ?? ''))
      } else {
        throw new Error(
          `Fill is not supported for <${elementInfo.tagName || 'unknown'}> elements that are not contenteditable`
        )
      }

      await assertOutcome(outcome, { value })

      await maybeDemoWait()
    },

    async append(trigger, value, options) {
      await maybeDemoWait()

      const interaction = resolveInteraction('append', trigger)
      const executionOptions = normalizeExecutionOptions(options, 'outcome')
      const outcome = resolveOutcome(interaction, 'append', executionOptions.outcome)

      const target = page.getByTestId(interaction.trigger).first()
      const elementInfo = await target.evaluate((el) => ({
        tagName: el.tagName?.toLowerCase?.() || '',
        isContentEditable: Boolean(el.isContentEditable),
      }))

      if (elementInfo.tagName === 'input' || elementInfo.tagName === 'textarea') {
        await target.evaluate((el, appendValue) => {
          const inputEl = el
          const base = String(inputEl.value ?? '')
          inputEl.value = `${base}${appendValue}`
          inputEl.dispatchEvent(new Event('input', { bubbles: true }))
          inputEl.dispatchEvent(new Event('change', { bubbles: true }))
        }, value)
      } else {
        await target.click()
        if (elementInfo.isContentEditable) {
          await page.keyboard.press('Control+End')
        }
        await page.keyboard.insertText(String(value ?? ''))
      }

      await assertOutcome(outcome, { value })

      await maybeDemoWait()
    },

    async action(trigger, options) {
      await maybeDemoWait()

      const interaction = resolveInteraction('action', trigger)
      const executionOptions = normalizeExecutionOptions(options, 'outcome')
      const outcome = resolveOutcome(interaction, 'action', executionOptions.outcome)

      const notificationBefore = (outcome.successNotificationSinceAction)
        ? await readNotificationProbeSnapshot()
        : null

      await page.getByTestId(interaction.trigger).click()

      await assertOutcome(outcome, {
        notificationSeqBefore: notificationBefore?.seq ?? 0,
      })

      await maybeDemoWait()
    },

    async ensure(trigger, options) {
      await maybeDemoWait()

      const executionOptions = normalizeExecutionOptions(options, 'desiredState')
      const interaction = resolveInteraction('ensure', trigger)
      const outcome = resolveOutcome(interaction, 'ensure', executionOptions.outcome)

      const toggle = page.getByTestId(interaction.trigger).first()
      const desiredState = executionOptions.desiredState ?? interaction.desiredState
      const currentState = await toggle.getAttribute('data-state')

      if (!desiredState || currentState !== desiredState) {
        await toggle.click()
      }

      await assertOutcome(outcome)

      await maybeDemoWait()
    },

    async clickByText(trigger, text, options) {
      await maybeDemoWait()

      const interaction = resolveInteraction('clickByText', trigger)
      const executionOptions = normalizeExecutionOptions(options, 'outcome')
      const outcome = resolveOutcome(interaction, 'clickByText', executionOptions.outcome)

      const queryText = String(text ?? '').trim()
      if (!queryText) {
        throw new Error('clickByText requires a non-empty text value')
      }

      const scope = page.getByTestId(interaction.trigger)
      const candidate = interaction.findSelector
        ? scope.locator(interaction.findSelector).filter({ hasText: queryText }).first()
        : scope.getByText(queryText, { exact: interaction.exact === true }).first()

      await expect(candidate).toBeVisible()
      await candidate.click()

      await assertOutcome(outcome, { value: queryText, text: queryText })

      await maybeDemoWait()
    },

    async clickRow(trigger, rowNumber, options) {
      await maybeDemoWait()

      const interaction = resolveInteraction('clickRow', trigger)
      const executionOptions = normalizeExecutionOptions(options, 'outcome')
      const outcome = resolveOutcome(interaction, 'clickRow', executionOptions.outcome)

      const parsedRowNumber = Number(rowNumber)
      const safeRowNumber = Number.isFinite(parsedRowNumber) && parsedRowNumber > 0
        ? Math.floor(parsedRowNumber)
        : 1

      const rowTargetPrefix = String(interaction.rowTargetPrefix || '').trim()
      if (!rowTargetPrefix) {
        throw new Error('clickRow interaction requires a non-empty "rowTargetPrefix"')
      }

      const rowTestId = `${rowTargetPrefix}${safeRowNumber}`
      const rowTarget = page.getByTestId(rowTestId).first()

      await expect(rowTarget).toBeVisible()
      await rowTarget.click()

      await assertOutcome(outcome, { rowNumber: safeRowNumber, rowTestId })

      await maybeDemoWait()
    },

    async read(trigger, options) {
			// beim lesen kein warten
      const interaction = resolveInteraction('read', trigger)
      const executionOptions = normalizeExecutionOptions(options, 'outcome')
      const outcome = resolveOutcome(interaction, 'read', executionOptions.outcome)

      const target = page.getByTestId(interaction.trigger).first()
      await assertOutcome(outcome)

      const content = await target.evaluate((el) => {
        const tagName = el.tagName?.toLowerCase?.() || ''
        if (tagName === 'input' || tagName === 'textarea') {
          return String(el.value ?? '')
        }
        if (el.isContentEditable) {
          const root = el.closest('.cm-editor')
          const docText = root?.cmView?.view?.state?.doc?.toString?.()
          if (typeof docText === 'string') {
            return docText
          }
          return String(el.innerText ?? el.textContent ?? '')
        }
        return String(el.textContent ?? '')
      })

      return content
    }
  }
}

export function extractLineBySubstring(content, needle) {
  const source = String(content ?? '')
  const query = String(needle ?? '').trim()
  if (!query) return null

  const lines = source.split(/\r?\n/)
  return lines.find((line) => line.includes(query)) ?? null
}

// 