/**
 * Central Fill Strategies for Standard Quasar Components
 *
 * These strategies are framework-level and app-agnostic. They handle:
 * - Standard Quasar inputs (q-field with text/number)
 * - Standard Quasar selects (q-select dropdowns)
 * - Generic HTML inputs and textareas
 * - Generic contenteditable elements
 *
 * For app-specific behavior, see <app>/env/fill-strategies.mjs
 *
 * Each strategy exports:
 * - name: identifier for debugging
 * - match(ctx): returns true if this strategy handles the element
 * - run(ctx): executes the interaction, returns { handled: true/false }
 */

export const centralFillStrategies = [
  {
    name: 'quasar-native-input',
    async match({ testId, isSelect, elementInfo }) {
      if (isSelect) return false
      const className = String(elementInfo?.className || '')
      return (
        (elementInfo?.tagName === 'input' || elementInfo?.tagName === 'textarea') &&
        className.includes('q-field__native')
      )
    },
    async run({ locator, expectedValue, isAppend }) {
      await locator.click()
      if (isAppend) {
        await locator.press('End')
      } else {
        await locator.press('Control+a')
        await locator.press('Backspace')
      }
      if (expectedValue) {
        await locator.type(expectedValue, { delay: 40 })
      }

      // Force commit sequence for model-driven form state
      await locator.dispatchEvent('input')
      await locator.dispatchEvent('change')
      await locator.blur()
      return { handled: true }
    },
  },

  {
    name: 'quasar-select',
    async match({ testId, isSelect, elementInfo }) {
      if (!isSelect) return false
      // Match if element itself has combobox role or if parent/grandparent is q-select
      const hasComboboxRole = elementInfo?.role === 'combobox'
      const hasQSelectParent = elementInfo?.className?.includes?.('q-field__native')
      const tagName = String(elementInfo?.tagName || '').toLowerCase()
      const hasPopup = String(elementInfo?.ariaHasPopup || '').length > 0
      return hasComboboxRole || hasQSelectParent || tagName === 'input' || hasPopup
    },
    async run({ page, locator, expectedValue }) {
      if (!expectedValue) {
        return { handled: false }
      }

      const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const optionPattern = new RegExp(`^\\s*${escapeRegExp(expectedValue)}\\s*$`, 'i')

      await locator.click({ force: true }).catch(() => {})
      await page.waitForTimeout(150)

      const container = locator.locator('..').first()
      await container.click({ force: true }).catch(() => {})
      await page.waitForTimeout(300)

      const optionLocator = page
        .locator('[role="option"], [role="menuitem"], .q-menu .q-item')
        .filter({ hasText: optionPattern })
        .first()

      let optionCount = await optionLocator.count()
      if (optionCount === 0) {
        // Quasar dropdowns can virtualize options. Scroll the opened menu to materialize offscreen entries.
        const activeMenu = page.locator('.q-menu:visible').last()
        await activeMenu.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
        await activeMenu.hover().catch(() => {})

        for (let index = 0; index < 18; index += 1) {
          await page.mouse.wheel(0, 320)
          await page.waitForTimeout(120)
          optionCount = await optionLocator.count()
          if (optionCount > 0) {
            break
          }
        }
      }

      if (optionCount === 0) {
        throw new Error(`Option "${expectedValue}" not found in select dropdown`)
      }

      await optionLocator.scrollIntoViewIfNeeded()
      await optionLocator.click({ force: true })
      await page.waitForTimeout(200)

      return { handled: true }
    },
  },

  {
    name: 'generic-input',
    async match({ testId, isSelect, elementInfo }) {
      if (isSelect) return false
      const tagName = String(elementInfo?.tagName || '').toLowerCase()
      return tagName === 'input' || tagName === 'textarea'
    },
    async run({ page, locator, expectedValue, isAppend }) {
      if (!expectedValue && !isAppend) {
        return { handled: false }
      }

      await locator.click()
      if (isAppend) {
        await locator.press('End')
        if (expectedValue) {
          await locator.type(expectedValue, { delay: 40 })
        }
      } else {
        await locator.fill(expectedValue)
      }
      await page.keyboard.press('Tab')

      return { handled: true }
    },
  },

  {
    // Quasar QEditor exposes its data-id on the editor wrapper. The runtime
    // resolves that wrapper to this contenteditable child before strategies
    // are selected.
    name: 'quasar-editor-contenteditable',
    async match({ isSelect, elementInfo }) {
      if (isSelect) return false
      const className = String(elementInfo?.className || '')
      return elementInfo?.isContentEditable === true && className.includes('q-editor__content')
    },
    async run({ page, locator, expectedValue, isAppend }) {
      if (!expectedValue && !isAppend) {
        return { handled: false }
      }

      await locator.click()
      if (isAppend) {
        await page.keyboard.press('Control+End').catch(() => {})
      } else {
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Delete')
      }

      if (expectedValue) {
        // insertText belongs to Playwright's Keyboard API, not to DOM elements.
        await page.keyboard.insertText(expectedValue)
      }

      await locator.dispatchEvent('input', { inputType: 'insertText', data: expectedValue })
      await locator.dispatchEvent('change')
      await page.keyboard.press('Tab')
      return { handled: true }
    },
  },

  {
    name: 'generic-contenteditable',
    async match({ testId, isSelect, elementInfo }) {
      if (isSelect) return false
      return elementInfo?.isContentEditable === true
    },
    async run({ page, locator, expectedValue, isAppend }) {
      if (!expectedValue && !isAppend) {
        return { handled: false }
      }

      await locator.click()
      if (isAppend) {
        await page.keyboard.press('Control+End').catch(() => {})
        if (expectedValue) {
          await locator.type(expectedValue, { delay: 40 })
        }
      } else {
        // Playwright supports filling contenteditable elements directly.
        try {
          await locator.fill(expectedValue)
        } catch {
          // Fallback for editors that block fill and only react to key input.
          await page.keyboard.press('Control+A')
          await page.keyboard.press('Backspace')
          if (expectedValue) {
            await locator.pressSequentially(expectedValue)
          }
        }
      }

      await page.keyboard.press('Tab')

      return { handled: true }
    },
  },
]
