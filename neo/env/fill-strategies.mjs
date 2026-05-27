export const fillStrategies = [
  {
    name: 'quasar-menu-option-click',
    async match({ elementInfo, isClick }) {
      if (!isClick) return false
      const role = String(elementInfo?.role || '')
      const className = String(elementInfo?.className || '')
      const tagName = String(elementInfo?.tagName || '').toLowerCase()

      return (
        role === 'option' ||
        role === 'menuitem' ||
        className.includes('q-item') ||
        className.includes('q-option') ||
        tagName === 'q-item'
      )
    },
    async run({ locator }) {
      await locator.scrollIntoViewIfNeeded()
      await locator.waitFor({ state: 'visible' })
      await locator.click({ force: true })
      return { handled: true }
    },
  },
]

export default fillStrategies
