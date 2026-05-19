(() => {
  console.clear()

  console.log('Interaction recorder gestartet.')

  const interactions = []

  const selectorStrategies = [
    {
      key: 'testid',
      closestSelector: '[data-testid]',
      getValue: (el) => el?.dataset?.testid || null
    },
    {
      key: 'data-id',
      closestSelector: '[data-id]',
      getValue: (el) => el?.getAttribute('data-id') || null
    },
    {
      key: 'id',
      closestSelector: '[id]',
      getValue: (el) => el?.id || null
    },
    {
      key: 'name',
      closestSelector: '[name]',
      getValue: (el) => el?.getAttribute('name') || null
    }
  ]

  function findBestTarget(element) {
    for (const strategy of selectorStrategies) {
      const targetElement = element.closest(strategy.closestSelector)
      if (!targetElement) {
        continue
      }

      const selectorValue = String(strategy.getValue(targetElement) || '').trim()
      if (!selectorValue) {
        continue
      }

      return {
        selectorKey: strategy.key,
        selectorValue,
        targetElement
      }
    }

    return null
  }

  function getElementInfo(element) {
    if (!element) {
      return null
    }

    const targetInfo = findBestTarget(element)
    if (!targetInfo) {
      return null
    }

    return {
      selectorKey: targetInfo.selectorKey,
      selectorValue: targetInfo.selectorValue,
      tag: targetInfo.targetElement.tagName.toLowerCase(),
      text: (targetInfo.targetElement.innerText || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 120)
    }
  }

  document.addEventListener(
    'click',
    (event) => {
      const info = getElementInfo(event.target)

      if (!info) {
        return
      }

      const interaction = {
        ts: new Date().toISOString(),
        interaction: {
          type: 'click',
          target: {
            [info.selectorKey]: info.selectorValue
          }
        },
        meta: {
          selectorKey: info.selectorKey,
          selectorValue: info.selectorValue,
          tag: info.tag,
          text: info.text
        }
      }

      interactions.push(interaction)

      console.log('--- CLICK RECORDED ---')
      console.log(interaction)

      console.log(
        `
- id: ${info.selectorValue}

  interaction:
    type: click

    target:
      ${info.selectorKey}: ${info.selectorValue}
`
      )
    },
    true
  )

  window.__interactionRecorder = {
    getAll() {
      return interactions
    },

    clear() {
      interactions.length = 0
      console.log('Interaction recorder geleert.')
    },

    exportYaml() {
      const yaml = interactions
        .map((entry) => {
          const target = entry.interaction.target || {}
          const selectorKey = Object.keys(target)[0]
          const selectorValue = target[selectorKey]

          return `
- id: ${selectorValue}

  interaction:
    type: click

    target:
      ${selectorKey}: ${selectorValue}
`
        })
        .join('\n')

      console.log(yaml)

      return yaml
    }
  }

  console.log(`
Verfügbare Befehle:

__interactionRecorder.getAll()
__interactionRecorder.clear()
__interactionRecorder.exportYaml()
`)
})()