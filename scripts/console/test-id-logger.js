(() => {
  console.clear()

  console.log('Interaction recorder gestartet.')

  const interactions = []
  const lastRecordedValues = new Map()

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
      ariaLabel: String(
        targetInfo.targetElement.getAttribute('aria-label') ||
        element.getAttribute?.('aria-label') ||
        ''
      ).trim(),
      text: (targetInfo.targetElement.innerText || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 120)
    }
  }

  function buildInteractionTarget(info) {
    const target = {
      [info.selectorKey]: info.selectorValue
    }

    if (info.text) {
      target.text = info.text
    }

    if (info.ariaLabel) {
      target['aria-label'] = info.ariaLabel
    }

    return target
  }

  function getElementValue(element) {
    if (!element) {
      return ''
    }

    const tagName = String(element.tagName || '').toLowerCase()
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
      return String(element.value ?? '')
    }

    if (element.isContentEditable) {
      return String(element.textContent || '').trim()
    }

    return String(element.getAttribute('value') || '')
  }

  function makeStepId(info, interactionType) {
    const suffix = interactionType === 'fill' ? 'fill' : interactionType
    return `${info.selectorValue}-${suffix}`
      .toLowerCase()
      .replace(/[^a-z0-9/_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  }

  function logJsonSnippet(entry) {
    const target = entry.interaction.target || {}
    const interactionType = entry.interaction.type
    const firstTargetValue = String(Object.values(target)[0] || '')
    const snippet = {
      id: entry.id || firstTargetValue,
      interaction: {
        type: interactionType,
        target,
      },
    }

    if (entry.interaction.value != null) {
      snippet.interaction.value = String(entry.interaction.value)
    }

    console.log(JSON.stringify(snippet, null, 2))
  }

  function recordInteraction(eventName, eventTarget, interactionType, options = {}) {
    const info = getElementInfo(eventTarget)

    if (!info) {
      return
    }

    const rawValue = options.readValue ? getElementValue(eventTarget) : null
    const value = rawValue == null ? null : String(rawValue)
    const dedupeKey = `${info.selectorKey}:${info.selectorValue}:${interactionType}`

    if (options.skipEmptyValue && value != null && value.trim() === '') {
      return
    }

    if (options.dedupeByValue && value != null) {
      const previous = lastRecordedValues.get(dedupeKey)
      if (previous === value) {
        return
      }
      lastRecordedValues.set(dedupeKey, value)
    }

    const interaction = {
      id: makeStepId(info, interactionType),
      ts: new Date().toISOString(),
      interaction: {
        type: interactionType,
        target: buildInteractionTarget(info)
      },
      meta: {
        eventName,
        selectorKey: info.selectorKey,
        selectorValue: info.selectorValue,
        tag: info.tag,
        text: info.text,
        ariaLabel: info.ariaLabel
      }
    }

    if (value != null) {
      interaction.interaction.value = value
      interaction.meta.value = value
    }

    interactions.push(interaction)

    console.log(`--- ${interactionType.toUpperCase()} RECORDED (${eventName}) ---`)
    console.log(interaction)
    logJsonSnippet(interaction)
  }

  document.addEventListener(
    'click',
    (event) => {
      recordInteraction('click', event.target, 'click')
    },
    true
  )

  document.addEventListener(
    'change',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      const role = String(target.getAttribute('role') || '').toLowerCase()
      const tagName = String(target.tagName || '').toLowerCase()
      const isSelectLike =
        tagName === 'select' ||
        role === 'combobox' ||
        role === 'listbox' ||
        String(target.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox'

      if (!isSelectLike) {
        return
      }

      recordInteraction('change', target, 'select', {
        readValue: true,
        skipEmptyValue: true,
        dedupeByValue: true
      })
    },
    true
  )

  document.addEventListener(
    'blur',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      const tagName = String(target.tagName || '').toLowerCase()
      const isFillable =
        tagName === 'input' ||
        tagName === 'textarea' ||
        target.isContentEditable === true

      if (!isFillable) {
        return
      }

      recordInteraction('blur', target, 'fill', {
        readValue: true,
        dedupeByValue: true
      })
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

    exportJson() {
      const jsonText = JSON.stringify(interactions, null, 2)
      console.log(jsonText)
      return jsonText
    }
  }

  console.log(`
Verfügbare Befehle:

__interactionRecorder.getAll()
__interactionRecorder.clear()
__interactionRecorder.exportJson()
`)
})()