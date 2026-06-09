(() => {
  console.clear()

  console.log('Interaction recorder gestartet.')

  const interactions = []
  const lastRecordedValues = new Map()

  const selectorStrategies = [
    {
      key: 'data-testid',
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
    const inputType = String(element.getAttribute?.('type') || '').toLowerCase()
    if (tagName === 'input' && inputType === 'file') {
      const files = Array.from(element.files || [])
        .map((file) => String(file?.name || '').trim())
        .filter(Boolean)
      return files.join(', ')
    }

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
    console.log(buildXmlSnippet(entry))
  }

  function escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  function toScenarioTagName(interactionType) {
    switch (String(interactionType || '').toLowerCase()) {
      case 'click':
        return 'Click'
      case 'fill':
        return 'Eingabe'
      case 'select':
        return 'Auswahl'
      case 'upload':
        return 'Upload'
      default:
        return 'Aktion'
    }
  }

  function buildScenarioAttributes(entry) {
    const interactionType = String(entry?.interaction?.type || '').toLowerCase()
    const target = entry?.interaction?.target && typeof entry.interaction.target === 'object'
      ? entry.interaction.target
      : {}
    const attributes = []

    if (target['data-id']) {
      attributes.push(['data-id', target['data-id']])
    } else {
      for (const key of ['data-testid', 'id', 'name', 'text', 'aria-label']) {
        const value = String(target[key] || '').trim()
        if (value) {
          attributes.push([key, value])
        }
      }
    }

    if (interactionType === 'click' && !target['data-id']) {
      for (const key of ['text', 'aria-label']) {
        const value = String(target[key] || '').trim()
        if (value && !attributes.some(([existingKey]) => existingKey === key)) {
          attributes.push([key, value])
        }
      }
    }

    return attributes
  }

  function buildXmlSnippet(entry) {
    const interactionType = String(entry?.interaction?.type || '').toLowerCase()
    const tagName = toScenarioTagName(interactionType)
    const attributes = buildScenarioAttributes(entry)
    const renderedAttributes = attributes
      .map(([key, value]) => `${key}="${escapeXml(value)}"`)
      .join(' ')
    const attributeSuffix = renderedAttributes ? ` ${renderedAttributes}` : ''
    const rawValue = entry?.interaction?.value
    const value = rawValue == null ? '' : String(rawValue)

    if (interactionType === 'fill' || interactionType === 'select' || interactionType === 'upload') {
      return `<${tagName}${attributeSuffix}>${escapeXml(value)}</${tagName}>`
    }

    return `<${tagName}${attributeSuffix}/>`
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
      const target = event.target
      if (target instanceof Element) {
        const interactiveField = target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
        if (interactiveField) {
          return
        }
        const uploadInput = target.closest('input[type="file"]')
        if (uploadInput) {
          return
        }
      }
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
      const inputType = String(target.getAttribute('type') || '').toLowerCase()
      const isFileUpload = tagName === 'input' && inputType === 'file'
      const isSelectLike =
        tagName === 'select' ||
        role === 'combobox' ||
        role === 'listbox' ||
        String(target.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox'

      if (isFileUpload) {
        recordInteraction('change', target, 'upload', {
          readValue: true,
          skipEmptyValue: true,
          dedupeByValue: true
        })
        return
      }

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
      const inputType = String(target.getAttribute('type') || '').toLowerCase()
      if (tagName === 'input' && inputType === 'file') {
        return
      }
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
    },

    exportXml() {
      const xmlText = interactions.map((entry) => buildXmlSnippet(entry)).join('\n')
      console.log(xmlText)
      return xmlText
    }
  }

  console.log(`
Verfügbare Befehle:

__interactionRecorder.getAll()
__interactionRecorder.clear()
__interactionRecorder.exportJson()
__interactionRecorder.exportXml()
`)
})()
