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
    async run({ locator, expectedValue }) {
      await locator.click()
      await locator.press('Control+a')
      await locator.press('Backspace')
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
      return hasComboboxRole || hasQSelectParent
    },
    async run({ page, locator, expectedValue }) {
      if (!expectedValue) {
        return { handled: false }
      }

      const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const optionPattern = new RegExp(`^\\s*${escapeRegExp(expectedValue)}\\s*$`, 'i')

      // Find the actual input or parent q-select container
      const container = locator.locator('..').first()
      await container.click()
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
    async run({ page, locator, expectedValue }) {
      if (!expectedValue) {
        return { handled: false }
      }

      await locator.click()
      await locator.fill(expectedValue)
      await page.keyboard.press('Tab')

      return { handled: true }
    },
  },

  {
    name: 'generic-contenteditable',
    async match({ testId, isSelect, elementInfo }) {
      if (isSelect) return false
      return elementInfo?.contentEditable === 'true'
    },
    async run({ page, locator, expectedValue }) {
      if (!expectedValue) {
        return { handled: false }
      }

      await locator.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Delete')

      // For contenteditable, use insertText to avoid key events
      await page.evaluate(
        ({ text }) => {
          const el = document.activeElement
          if (el?.contentEditable === 'true') {
            el.insertText(text)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }
        },
        { text: expectedValue }
      )

      await page.keyboard.press('Tab')

      return { handled: true }
    },
  },
]
