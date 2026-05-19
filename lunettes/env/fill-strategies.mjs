/**
 * App-specific fill strategies for Lunettes.
 *
 * Central Quasar strategies (quasar-native-input, quasar-select) are handled by the generator.
 * Only app-specific overrides or custom components are here.
 */
export const fillStrategies = [
  {
    name: 'anforderungsviewer-plaintext-editor-content',
    async match({ testId }) {
      return testId === 'anforderungsviewer-plaintext-editor-content'
    },
    async run({ locator, page, expectedValue, elementInfo, isAppend }) {
      const normalizePlaintext = (text) => String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')

      const readPlaintextContent = async () => locator.evaluate((el) => {
        const normalizePlaintext = (text) => String(text ?? '')
          .replace(/\r\n/g, '\n')
          .replace(/^\n+/, '')
          .replace(/\n+$/, '')

        const tagName = el.tagName?.toLowerCase?.() || ''
        if (tagName === 'input' || tagName === 'textarea') {
          return normalizePlaintext(el.value)
        }

        if (el.isContentEditable) {
          const root = el.closest('.cm-editor')
          const docText = root?.cmView?.view?.state?.doc?.toString?.()
          if (typeof docText === 'string') {
            return normalizePlaintext(docText)
          }

          return normalizePlaintext(el.innerText ?? el.textContent ?? '')
        }

        return normalizePlaintext(el.textContent)
      })

      const currentContent = await readPlaintextContent()
      const rawExpectedValue = String(expectedValue ?? '')
      const appendMode = Boolean(isAppend) || rawExpectedValue.startsWith('\n')
      const expectedFinalContent = appendMode
        ? normalizePlaintext(`${currentContent}${rawExpectedValue}`)
        : normalizePlaintext(rawExpectedValue)

      if (elementInfo?.tagName === 'input' || elementInfo?.tagName === 'textarea') {
        if (appendMode) {
          await locator.fill(`${currentContent}${rawExpectedValue}`)
        } else {
          await locator.fill(rawExpectedValue)
        }
      } else {
        await locator.click()
        if (appendMode) {
          await page.keyboard.press('Control+End')
        } else {
          await page.keyboard.press('Control+A')
        }
        await page.keyboard.insertText(rawExpectedValue)

        await locator.evaluate((el) => {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        })
      }

      await page.waitForTimeout(150)

      const normalizedActual = await readPlaintextContent()

      if (normalizedActual !== expectedFinalContent) {
        throw new Error(
          `Plaintext editor did not persist expected content. Expected ${JSON.stringify(expectedFinalContent)}, got ${JSON.stringify(normalizedActual)}`
        )
      }

      return { handled: true, verify: false }
    },
  },
  {
    name: 'idee-description-editor-contenteditable',
    async match({ testId, elementInfo }) {
      return testId === 'idee-view-description-editor-input' && Boolean(elementInfo?.isContentEditable)
    },
    async run({ page, locator, expectedValue }) {
      await locator.click()
      await page.keyboard.press('Control+a')
      await page.keyboard.press('Backspace')

      if (expectedValue) {
        // Use insertText in one shot to avoid per-keystroke re-render side effects
        await page.keyboard.insertText(expectedValue)
      }

      await locator.evaluate((el) => {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await locator.blur()
      return { handled: true }
    },
  },
]

export default fillStrategies
