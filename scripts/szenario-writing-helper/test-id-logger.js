(() => {
  console.clear()

  console.log('Interaction recorder gestartet.')

  const interactions = []
  const lastRecordedValues = new Map()
  const hoverDelayMs = 1000
  const hoverRadiusPx = 50
  const hoverState = {
    timerId: null,
    anchorX: null,
    anchorY: null,
    lastX: null,
    lastY: null,
    popupAnchorX: null,
    popupAnchorY: null,
    popupVisible: false,
    popupHovered: false,
    popupLocked: false,
    highlightedElements: []
  }

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

  function ensureHoverPopup() {
    let popup = document.getElementById('__test_id_logger_hover_popup__')
    if (popup) {
      return popup
    }

    popup = document.createElement('div')
    popup.id = '__test_id_logger_hover_popup__'
    popup.style.position = 'fixed'
    popup.style.zIndex = '2147483647'
    popup.style.maxWidth = '420px'
    popup.style.maxHeight = '280px'
    popup.style.overflow = 'auto'
    popup.style.padding = '10px 12px'
    popup.style.borderRadius = '8px'
    popup.style.background = 'rgba(20, 20, 20, 0.96)'
    popup.style.color = '#fff'
    popup.style.font = '12px/1.4 monospace'
    popup.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.35)'
    popup.style.whiteSpace = 'pre-wrap'
    popup.style.display = 'none'
    popup.addEventListener('mouseenter', () => {
      hoverState.popupHovered = true
      hoverState.popupLocked = true
      clearHoverTimer()
    })
    popup.addEventListener('mouseleave', () => {
      hoverState.popupHovered = false
    })
    popup.addEventListener('click', async (event) => {
      const closeButton = event.target instanceof Element
        ? event.target.closest('[data-close-hover-popup]')
        : null

      if (closeButton instanceof HTMLElement) {
        forceHideHoverPopup()
        return
      }

      const button = event.target instanceof Element
        ? event.target.closest('[data-copy-data-id]')
        : null

      if (!(button instanceof HTMLElement)) {
        return
      }

      const dataId = String(button.getAttribute('data-copy-data-id') || '').trim()
      if (!dataId) {
        return
      }

      try {
        await navigator.clipboard.writeText(dataId)
        highlightElementsForDataId(dataId)
        button.textContent = `kopiert: ${dataId}`
        window.setTimeout(() => {
          if (button.isConnected) {
            button.textContent = button.getAttribute('data-entry-label') || dataId
          }
        }, 1200)
      } catch (error) {
        console.error('Kopieren der data-id fehlgeschlagen.', error)
      }
    })
    document.body.appendChild(popup)
    return popup
  }

  function clearHoverTimer() {
    if (hoverState.timerId != null) {
      window.clearTimeout(hoverState.timerId)
      hoverState.timerId = null
    }
  }

  function hideHoverPopup() {
    if (hoverState.popupHovered || hoverState.popupLocked) {
      return
    }

    clearHoverTimer()
    clearHighlightedElements()
    const popup = document.getElementById('__test_id_logger_hover_popup__')
    if (popup) {
      popup.style.display = 'none'
      popup.innerHTML = ''
    }
    hoverState.popupVisible = false
  }

  function forceHideHoverPopup() {
    hoverState.popupHovered = false
    hoverState.popupLocked = false
    hoverState.popupAnchorX = null
    hoverState.popupAnchorY = null
    clearHoverTimer()
    clearHighlightedElements()
    const popup = getHoverPopup()
    if (popup) {
      popup.style.display = 'none'
      popup.innerHTML = ''
    }
    hoverState.popupVisible = false
  }

  function clearHighlightedElements() {
    for (const element of hoverState.highlightedElements) {
      if (!(element instanceof HTMLElement)) {
        continue
      }

      const previousOutline = element.dataset.testIdLoggerPreviousOutline
      const previousOutlineOffset = element.dataset.testIdLoggerPreviousOutlineOffset

      if (previousOutline != null) {
        element.style.outline = previousOutline
        delete element.dataset.testIdLoggerPreviousOutline
      }

      if (previousOutlineOffset != null) {
        element.style.outlineOffset = previousOutlineOffset
        delete element.dataset.testIdLoggerPreviousOutlineOffset
      }
    }

    hoverState.highlightedElements = []
  }

  function getHoverPopup() {
    const popup = document.getElementById('__test_id_logger_hover_popup__')
    return popup instanceof HTMLElement ? popup : null
  }

  function getDistanceToPopup(x, y) {
    const popup = getHoverPopup()
    if (!popup || popup.style.display === 'none') {
      return null
    }

    return getDistanceToRect(x, y, popup.getBoundingClientRect())
  }

  function isPointInRect(x, y, rect, padding = 0) {
    return (
      x >= rect.left - padding &&
      x <= rect.right + padding &&
      y >= rect.top - padding &&
      y <= rect.bottom + padding
    )
  }

  function isMovingWithinPopupApproachZone(x, y) {
    if (!hoverState.popupVisible || hoverState.popupLocked || hoverState.popupHovered) {
      return false
    }

    const popup = getHoverPopup()
    const anchorX = hoverState.popupAnchorX
    const anchorY = hoverState.popupAnchorY
    if (!popup || anchorX == null || anchorY == null) {
      return false
    }

    const rect = popup.getBoundingClientRect()
    if (isPointInRect(x, y, rect, 12)) {
      return true
    }

    const corridorPadding = 18
    const corridorRect = {
      left: Math.min(anchorX, rect.left) - corridorPadding,
      right: Math.max(anchorX, rect.right) + corridorPadding,
      top: Math.min(anchorY, rect.top) - corridorPadding,
      bottom: Math.max(anchorY, rect.bottom) + corridorPadding
    }

    return isPointInRect(x, y, corridorRect)
  }

  function isMovingTowardPopup(nextX, nextY) {
    if (!hoverState.popupVisible || hoverState.lastX == null || hoverState.lastY == null) {
      return false
    }

    const previousDistance = getDistanceToPopup(hoverState.lastX, hoverState.lastY)
    const nextDistance = getDistanceToPopup(nextX, nextY)
    if (previousDistance == null || nextDistance == null) {
      return false
    }

    return nextDistance <= previousDistance
  }

  function highlightElementsForDataId(dataId) {
    clearHighlightedElements()

    const selector = `[data-id=${JSON.stringify(String(dataId))}]`
    const elements = Array.from(document.querySelectorAll(selector))
      .filter((element) => element instanceof HTMLElement)

    for (const element of elements) {
      element.dataset.testIdLoggerPreviousOutline = element.style.outline || ''
      element.dataset.testIdLoggerPreviousOutlineOffset = element.style.outlineOffset || ''
      element.style.outline = '2px solid red'
      element.style.outlineOffset = '1px'
    }

    hoverState.highlightedElements = elements
  }

  function getDistanceToRect(x, y, rect) {
    const dx = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0)
    const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0)
    return Math.hypot(dx, dy)
  }

  function collectNearbyDataIds(x, y, radiusPx) {
    const candidates = Array.from(document.querySelectorAll('[data-id]'))
    const matches = []

    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) {
        continue
      }

      const dataId = String(element.getAttribute('data-id') || '').trim()
      if (!dataId) {
        continue
      }

      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        continue
      }

      const distance = getDistanceToRect(x, y, rect)
      if (distance > radiusPx) {
        continue
      }

      matches.push({
        dataId,
        tagName: element.tagName.toLowerCase(),
        distance,
        area: rect.width * rect.height
      })
    }

    matches.sort((left, right) => (
      left.distance - right.distance ||
      left.area - right.area ||
      left.dataId.localeCompare(right.dataId)
    ))

    const seen = new Set()
    return matches.filter((entry) => {
      const dedupeKey = `${entry.tagName}::${entry.dataId}`
      if (seen.has(dedupeKey)) {
        return false
      }
      seen.add(dedupeKey)
      return true
    })
  }

  function showHoverPopup(x, y) {
    const popup = ensureHoverPopup()
    const nearbyEntries = collectNearbyDataIds(x, y, hoverRadiusPx)
    popup.innerHTML = ''

    const header = document.createElement('div')
    header.style.display = 'flex'
    header.style.alignItems = 'center'
    header.style.justifyContent = 'space-between'
    header.style.gap = '8px'
    header.style.marginBottom = '8px'

    const title = document.createElement('div')
    title.textContent = `data-id Komponenten im Radius von ${hoverRadiusPx}px`
    title.style.fontWeight = '700'
    title.style.flex = '1'

    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.setAttribute('data-close-hover-popup', 'true')
    closeButton.textContent = 'x'
    closeButton.style.width = '24px'
    closeButton.style.height = '24px'
    closeButton.style.border = '1px solid rgba(255, 255, 255, 0.2)'
    closeButton.style.borderRadius = '999px'
    closeButton.style.background = 'rgba(255, 255, 255, 0.08)'
    closeButton.style.color = '#fff'
    closeButton.style.cursor = 'pointer'
    closeButton.style.font = 'inherit'
    closeButton.style.lineHeight = '1'
    closeButton.style.padding = '0'

    header.appendChild(title)
    header.appendChild(closeButton)
    popup.appendChild(header)

    if (nearbyEntries.length === 0) {
      const emptyState = document.createElement('div')
      emptyState.textContent = 'Keine Komponenten mit data-id im Radius gefunden.'
      popup.appendChild(emptyState)
    } else {
      const list = document.createElement('div')
      list.style.display = 'grid'
      list.style.gap = '6px'

      nearbyEntries.forEach((entry, index) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.setAttribute('data-copy-data-id', entry.dataId)
        row.setAttribute('data-entry-label', `${index + 1}. <${entry.tagName}> ${entry.dataId}`)
        row.textContent = row.getAttribute('data-entry-label')
        row.style.display = 'block'
        row.style.width = '100%'
        row.style.padding = '6px 8px'
        row.style.border = '1px solid rgba(255, 255, 255, 0.12)'
        row.style.borderRadius = '6px'
        row.style.background = 'rgba(255, 255, 255, 0.06)'
        row.style.color = '#fff'
        row.style.cursor = 'pointer'
        row.style.font = 'inherit'
        row.style.textAlign = 'left'
        list.appendChild(row)
      })

      popup.appendChild(list)
    }

    const offset = 16
    const maxLeft = Math.max(8, window.innerWidth - 440)
    const maxTop = Math.max(8, window.innerHeight - 300)
    popup.style.left = `${Math.min(x + offset, maxLeft)}px`
    popup.style.top = `${Math.min(y + offset, maxTop)}px`
    popup.style.display = 'block'
    hoverState.popupAnchorX = x
    hoverState.popupAnchorY = y
    hoverState.popupLocked = true
    hoverState.popupVisible = true
  }

  function scheduleHoverPopup(x, y) {
    clearHoverTimer()
    hoverState.anchorX = x
    hoverState.anchorY = y
    hoverState.timerId = window.setTimeout(() => {
      hoverState.timerId = null
      showHoverPopup(x, y)
    }, hoverDelayMs)
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
      const target = event.target instanceof Element ? event.target : null
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
    'mousemove',
    (event) => {
      const { clientX, clientY } = event
      const popup = getHoverPopup()
      const eventTarget = event.target instanceof Element ? event.target : null
      const pointerIsOnPopup = popup != null && eventTarget != null && popup.contains(eventTarget)
      const movingTowardPopup = isMovingTowardPopup(clientX, clientY)
      const movedSinceLast =
        hoverState.lastX == null ||
        hoverState.lastY == null ||
        Math.hypot(clientX - hoverState.lastX, clientY - hoverState.lastY) > 2

      if (pointerIsOnPopup) {
        hoverState.popupHovered = true
        hoverState.popupLocked = true
        hoverState.lastX = clientX
        hoverState.lastY = clientY
        clearHoverTimer()
        return
      }

      if (hoverState.popupVisible) {
        hoverState.popupHovered = false
        hoverState.lastX = clientX
        hoverState.lastY = clientY
        return
      }

      if (!movedSinceLast) {
        hoverState.lastX = clientX
        hoverState.lastY = clientY
        return
      }

      if (hoverState.popupHovered) {
        hoverState.lastX = clientX
        hoverState.lastY = clientY
        return
      }

      if (hoverState.popupLocked) {
        hoverState.lastX = clientX
        hoverState.lastY = clientY
        return
      }

      if (movingTowardPopup || isMovingWithinPopupApproachZone(clientX, clientY)) {
        hoverState.lastX = clientX
        hoverState.lastY = clientY
        return
      }

      hideHoverPopup()
      hoverState.lastX = clientX
      hoverState.lastY = clientY
      scheduleHoverPopup(clientX, clientY)
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
    },

    hideHoverPopup,
    forceHideHoverPopup
  }

  console.log(`
Verfügbare Befehle:

__interactionRecorder.getAll()
__interactionRecorder.clear()
__interactionRecorder.exportJson()
__interactionRecorder.exportXml()
__interactionRecorder.hideHoverPopup()
__interactionRecorder.forceHideHoverPopup()
`)
})()
