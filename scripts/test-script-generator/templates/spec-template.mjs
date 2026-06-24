import { basename } from 'path'
import { XMLParser } from 'fast-xml-parser'
import { getScenarioSpecImports, getScenarioSpecSetupLines } from './spec-template-base.mjs'

const REMOTION_INTERACTION_TAG_KIND = {
  Click: 'click',
  Eingabe: 'fill',
  Auswahl: 'select',
  Anzeige: 'show',
  Warten: 'wait',
  Oeffnen: 'open',
  SucheAuswahl: 'search-and-select',
}

const REMOTION_PRESENTATION_TAGS = new Set(['Folie', 'Info', 'Video', 'Ton'])

function toXmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function toXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function parseBoolLike(value, fallback = false) {
  if (value == null) {
    return fallback
  }

  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false
  }
  return fallback
}

function getNodeTag(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null
  }

  for (const key of Object.keys(node)) {
    if (key === ':@' || key === '#text' || key === '#comment' || key === '#cdata') {
      continue
    }
    if (key.startsWith('?')) {
      continue
    }
    return key
  }

  return null
}

function normalizeXmlAttributes(rawAttributes) {
  const attrs = {}
  for (const [key, value] of Object.entries(rawAttributes || {})) {
    attrs[String(key || '').replace(/^@_/, '')] = value == null ? '' : String(value)
  }
  return attrs
}

function toElementTreeFromNode(node) {
  const tag = getNodeTag(node)
  if (!tag) {
    return null
  }

  const payload = node[tag]
  const attrs = normalizeXmlAttributes(node[':@'])
  const children = []
  let text = ''

  for (const child of Array.isArray(payload) ? payload : []) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      if (Object.prototype.hasOwnProperty.call(child, '#text')) {
        text += String(child['#text'] || '')
        continue
      }

      const childElement = toElementTreeFromNode(child)
      if (childElement) {
        children.push(childElement)
      }
    }
  }

  return {
    tag,
    attrs,
    text,
    children,
  }
}

function parseResolvedXmlElementTree(resolvedXmlSource) {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })
  const parsed = parser.parse(String(resolvedXmlSource || ''))
  for (const node of Array.isArray(parsed) ? parsed : []) {
    const element = toElementTreeFromNode(node)
    if (element) {
      return element
    }
  }
  throw new Error('resolved.xml could not be parsed into an XML root element.')
}

function normalizedMs(value, fallback = 0) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return Math.max(0, Math.floor(fallback))
  }
  return Math.max(0, Math.floor(numeric))
}

function firstDefined(attrs, keys, fallback = null) {
  for (const key of keys) {
    if (attrs && Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] != null && String(attrs[key]).trim() !== '') {
      return attrs[key]
    }
  }
  return fallback
}

function estimateTtsDurationMs(text, explicitMs = null) {
  const explicit = Number(explicitMs)
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(300, Math.floor(explicit))
  }

  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  return Math.max(1200, Math.round(words * 380))
}

function sanitizeSensitiveText(value) {
  let out = String(value || '')
  out = out.replace(/(password|passwort|token|secret|api[_-]?key)\s*=\s*"[^"]*"/gi, '$1="***"')
  out = out.replace(/(password|passwort|token|secret|api[_-]?key)\s*=\s*'[^']*'/gi, "$1='***'")
  return out
}

function isSensitiveAttributeName(name) {
  return /(password|passwort|token|secret|api[_-]?key)/i.test(String(name || ''))
}

function isSensitiveAttributeValue(value) {
  return /(password|passwort|token|secret|api[_-]?key)/i.test(String(value || ''))
}

function isSensitiveStep(node) {
  for (const [key, value] of Object.entries(node?.attrs || {})) {
    if (isSensitiveAttributeName(key) || isSensitiveAttributeValue(value)) {
      return true
    }
  }
  return false
}

function buildTimelineIndex(timelineInput) {
  const rawSteps = Array.isArray(timelineInput)
    ? timelineInput
    : (Array.isArray(timelineInput?.steps) ? timelineInput.steps : [])

  const byStepId = new Map()
  const runtimeBlocks = []
  let minStart = Number.POSITIVE_INFINITY
  let maxEnd = Number.NEGATIVE_INFINITY

  for (const rawStep of rawSteps) {
    const startedAtMs = normalizedMs(rawStep?.startedAtMs)
    const endedAtMs = Math.max(startedAtMs, normalizedMs(rawStep?.endedAtMs, startedAtMs))
    const durationMs = Math.max(0, normalizedMs(rawStep?.durationMs, endedAtMs - startedAtMs))
    const status = String(rawStep?.status || '').trim() || 'unknown'
    const skipped = rawStep?.skipped === true || status.toLowerCase() === 'skipped'
    const stepId = String(rawStep?.stepId || '').trim()

    minStart = Math.min(minStart, startedAtMs)
    maxEnd = Math.max(maxEnd, endedAtMs)

    if (!stepId) {
      runtimeBlocks.push({
        startedAtMs,
        endedAtMs,
        durationMs,
        status,
        skipped,
      })
      continue
    }

    const existing = byStepId.get(stepId)
    if (!existing) {
      byStepId.set(stepId, {
        stepId,
        startedAtMs,
        endedAtMs,
        durationMs,
        status,
        skipped,
      })
      continue
    }

    const mergedStarted = Math.min(existing.startedAtMs, startedAtMs)
    const mergedEnded = Math.max(existing.endedAtMs, endedAtMs)
    byStepId.set(stepId, {
      stepId,
      startedAtMs: mergedStarted,
      endedAtMs: mergedEnded,
      durationMs: Math.max(0, mergedEnded - mergedStarted),
      status: existing.status,
      skipped: existing.skipped && skipped,
    })
  }

  return {
    byStepId,
    runtimeBlocks,
    originalDurationMs: Number.isFinite(minStart) && Number.isFinite(maxEnd) ? Math.max(0, maxEnd - minStart) : 0,
  }
}

function buildGeneratedStepTitle(node) {
  const tag = String(node?.tag || 'Step')
  const attrs = node?.attrs || {}
  const parts = [tag]
  const preferredAttrs = ['data-id', 'id', 'testid', 'text', 'aria-label', 'label', 'selektor-regex', 'treffer-index', 'url']
  const sensitiveStep = isSensitiveStep(node)

  for (const attrName of preferredAttrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, attrName)) {
      continue
    }

    const attrValue = String(attrs[attrName] || '').replace(/\s+/g, ' ').trim()
    if (!attrValue) {
      continue
    }

    if (sensitiveStep && (isSensitiveAttributeName(attrName) || isSensitiveAttributeValue(attrValue))) {
      parts.push(`${attrName}=***`)
    } else {
      parts.push(`${attrName}=${sanitizeSensitiveText(attrValue)}`)
    }
  }

  const inlineText = String(node?.text || '').replace(/\s+/g, ' ').trim()
  if (inlineText && !sensitiveStep) {
    parts.push(`value=${sanitizeSensitiveText(inlineText)}`)
  }

  return parts.join(' | ')
}

function renderVideoSegmentXml(entry, indent) {
  const lines = []
  lines.push(`${indent}<VideoSegment id="${toXmlAttr(entry.id)}" kind="${toXmlAttr(entry.kind)}" title="${toXmlAttr(entry.title)}" sourceVideo="${toXmlAttr(entry.sourceVideo)}">`)
  lines.push(`${indent}  <Original startMs="${entry.originalStartMs}" endMs="${entry.originalEndMs}" durationMs="${entry.originalDurationMs}"/>`)
  lines.push(`${indent}  <Composition startMs="${entry.compositionStartMs}" endMs="${entry.compositionEndMs}" durationMs="${entry.compositionDurationMs}"/>`)
  lines.push(`${indent}  <SourceStep stepId="${toXmlAttr(entry.stepId)}"/>`)
  if (entry.overlay) {
    lines.push(`${indent}  <Overlay type="click-indicator" beforeMs="${entry.overlay.beforeMs}" afterMs="${entry.overlay.afterMs}" fadeMs="${entry.overlay.fadeMs}"/>`)
  }
  lines.push(`${indent}</VideoSegment>`)
  return lines
}

function renderNarrationSequenceXml(entry, indent) {
  const lines = []
  if (entry.mode === 'freeze') {
    lines.push(`${indent}<NarrationSequence mode="freeze" afterStepId="${toXmlAttr(entry.afterStepId || '')}">`)
    if (entry.freezeSourceStepId) {
      lines.push(`${indent}  <FreezeFrame sourceStepId="${toXmlAttr(entry.freezeSourceStepId)}"/>`)
    }
    lines.push(`${indent}  <TTSRef id="${toXmlAttr(entry.ttsId)}"/>`)
    lines.push(`${indent}  <Composition startMs="${entry.compositionStartMs}" endMs="${entry.compositionEndMs}" durationMs="${entry.compositionDurationMs}"/>`)
    lines.push(`${indent}</NarrationSequence>`)
    return lines
  }

  lines.push(`${indent}<NarrationSequence mode="parallel-group" groupId="${toXmlAttr(entry.groupId)}" allowExtendGroup="${entry.allowExtendGroup ? 'true' : 'false'}">`)
  lines.push(`${indent}  <TTSRef id="${toXmlAttr(entry.ttsId)}"/>`)
  lines.push(`${indent}  <Composition startMs="${entry.compositionStartMs}" endMs="${entry.compositionEndMs}" durationMs="${entry.compositionDurationMs}"/>`)
  lines.push(`${indent}</NarrationSequence>`)
  return lines
}

function readPresentationDurationMs(node, fallback = 2000) {
  const attrs = node?.attrs || {}
  const explicit = firstDefined(attrs, ['duration-ms', 'dauer-ms', 'durationMs', 'dauerMs'], null)
  return Math.max(300, normalizedMs(explicit, fallback))
}

function getGroupNarrationMode(groupNode) {
  const attrs = groupNode?.attrs || {}
  const value = firstDefined(attrs, ['narration.mode', 'narration-mode', 'narration_mode'], 'freeze')
  return String(value || 'freeze').trim().toLowerCase() === 'parallel-group' ? 'parallel-group' : 'freeze'
}

function transformFlowNodeToEntries(node, context) {
  const tag = node?.tag
  if (!tag) {
    return
  }

  if (tag === 'Gruppe') {
    const groupId = String(firstDefined(node.attrs, ['id', 'name'], slugify('group')) || slugify('group'))
    const groupTitle = String(firstDefined(node.attrs, ['title', 'titel', 'name'], groupId) || groupId)
    const narrationMode = getGroupNarrationMode(node)
    const allowExtendGroup = parseBoolLike(firstDefined(node.attrs, ['allowExtendGroup', 'allow-extend-group'], false), false)

    const chapter = {
      type: 'chapter',
      id: groupId,
      title: sanitizeSensitiveText(groupTitle),
      narrationMode,
      allowExtendGroup,
      entries: [],
    }
    context.sequences.push(chapter)

    const groupState = {
      id: groupId,
      narrationMode,
      allowExtendGroup,
      firstVideoCompositionStartMs: null,
      lastVideoCompositionEndMs: null,
      parallelNarrations: [],
      chapter,
    }

    for (const child of node.children || []) {
      transformFlowNodeToEntries(child, {
        ...context,
        activeEntries: chapter.entries,
        activeGroup: groupState,
      })
    }

    if (groupState.narrationMode === 'parallel-group') {
      const groupStart = groupState.firstVideoCompositionStartMs
      const groupEnd = groupState.lastVideoCompositionEndMs
      const groupDurationMs = groupStart == null || groupEnd == null ? 0 : Math.max(0, groupEnd - groupStart)

      for (const narration of groupState.parallelNarrations) {
        if (groupDurationMs <= 0) {
          context.validationErrors.push({
            code: 'PARALLEL_GROUP_WITHOUT_VIDEO',
            groupId,
            ttsId: narration.ttsId,
            message: `Group "${groupId}" defines narration.mode=parallel-group but has no executable video steps.`,
          })
          narration.entry.compositionStartMs = context.compositionCursorMs
          narration.entry.compositionEndMs = context.compositionCursorMs
          narration.entry.compositionDurationMs = 0
          continue
        }

        if (!groupState.allowExtendGroup && narration.durationMs > groupDurationMs) {
          context.validationErrors.push({
            code: 'TTS_EXCEEDS_GROUP',
            groupId,
            ttsId: narration.ttsId,
            message: `TTS ${narration.ttsId} exceeds group duration (${narration.durationMs}ms > ${groupDurationMs}ms).`,
          })
        }

        narration.entry.compositionStartMs = groupStart
        narration.entry.compositionEndMs = groupStart + Math.min(narration.durationMs, groupDurationMs)
        narration.entry.compositionDurationMs = Math.max(0, narration.entry.compositionEndMs - narration.entry.compositionStartMs)

        if (groupState.allowExtendGroup && narration.durationMs > groupDurationMs) {
          const overflowMs = narration.durationMs - groupDurationMs
          const freezeEntry = {
            type: 'freeze-extension',
            afterGroupId: groupId,
            ttsId: narration.ttsId,
            durationMs: overflowMs,
            compositionStartMs: context.compositionCursorMs,
            compositionEndMs: context.compositionCursorMs + overflowMs,
            compositionDurationMs: overflowMs,
          }
          chapter.entries.push(freezeEntry)
          context.compositionCursorMs += overflowMs
        }
      }
    }
    return
  }

  if (tag === 'Folie') {
    const durationMs = readPresentationDurationMs(node, 2200)
    const slideEntry = {
      type: 'slide',
      id: String(firstDefined(node.attrs, ['id'], `slide-${context.slideCounter + 1}`)),
      title: sanitizeSensitiveText(String(firstDefined(node.attrs, ['title', 'titel', 'text'], node.text || 'Folie'))),
      compositionStartMs: context.compositionCursorMs,
      compositionEndMs: context.compositionCursorMs + durationMs,
      compositionDurationMs: durationMs,
    }
    context.slideCounter += 1
    context.activeEntries.push(slideEntry)
    context.compositionCursorMs += durationMs
    return
  }

  if (tag === 'Info') {
    const infoText = sanitizeSensitiveText(String(firstDefined(node.attrs, ['text'], node.text || '')).trim())
    if (!infoText) {
      return
    }

    const ttsId = `tts-${String(context.ttsCounter + 1).padStart(3, '0')}`
    const voice = String(firstDefined(node.attrs, ['voice'], context.options.defaultVoice || 'de-DE'))
    const durationMs = estimateTtsDurationMs(infoText, firstDefined(node.attrs, ['tts-duration-ms', 'duration-ms'], null))
    context.ttsCounter += 1
    context.ttsAssets.push({ id: ttsId, text: infoText, voice })

    if (context.activeGroup?.narrationMode === 'parallel-group') {
      const narrationEntry = {
        type: 'narration',
        mode: 'parallel-group',
        ttsId,
        groupId: context.activeGroup.id,
        allowExtendGroup: context.activeGroup.allowExtendGroup,
        compositionStartMs: 0,
        compositionEndMs: 0,
        compositionDurationMs: 0,
      }
      context.activeEntries.push(narrationEntry)
      context.activeGroup.parallelNarrations.push({
        ttsId,
        durationMs,
        entry: narrationEntry,
      })
      return
    }

    const startMs = context.compositionCursorMs
    const endMs = startMs + durationMs
    const narrationEntry = {
      type: 'narration',
      mode: 'freeze',
      ttsId,
      afterStepId: context.lastVideoStepId || '',
      freezeSourceStepId: context.lastVideoStepId || '',
      compositionStartMs: startMs,
      compositionEndMs: endMs,
      compositionDurationMs: durationMs,
    }
    context.activeEntries.push(narrationEntry)
    context.compositionCursorMs = endMs
    return
  }

  if (REMOTION_PRESENTATION_TAGS.has(tag)) {
    const durationMs = readPresentationDurationMs(node, 1200)
    const presentationEntry = {
      type: 'presentation',
      kind: String(tag).toLowerCase(),
      title: sanitizeSensitiveText(String(firstDefined(node.attrs, ['title', 'titel', 'text'], node.text || tag))),
      compositionStartMs: context.compositionCursorMs,
      compositionEndMs: context.compositionCursorMs + durationMs,
      compositionDurationMs: durationMs,
    }
    context.activeEntries.push(presentationEntry)
    context.compositionCursorMs += durationMs
    return
  }

  const interactionKind = REMOTION_INTERACTION_TAG_KIND[tag]
  if (interactionKind) {
    const attrs = node?.attrs || {}
    const stepId = String(firstDefined(attrs, ['resolved-id', 'stepId', 'step-id', 'id'], '') || '').trim()
    if (!stepId) {
      return
    }

    const resolvedTitle = String(firstDefined(attrs, ['resolved-title'], '') || '').trim()
    const title = sanitizeSensitiveText(resolvedTitle || buildGeneratedStepTitle(node))
    const timelineStep = context.timeline.byStepId.get(stepId)

    if (!timelineStep) {
      context.activeEntries.push({
        type: 'missing',
        resolvedId: stepId,
        title,
      })
      context.missingTimelineStepCount += 1
      return
    }

    if (timelineStep.skipped) {
      context.activeEntries.push({
        type: 'skipped',
        stepId,
        status: timelineStep.status,
        skipped: true,
      })
      return
    }

    const originalStartMs = timelineStep.startedAtMs
    const originalEndMs = timelineStep.endedAtMs
    const originalDurationMs = Math.max(0, timelineStep.durationMs || (originalEndMs - originalStartMs))
    const compositionStartMs = context.compositionCursorMs
    const compositionDurationMs = Math.max(1, originalDurationMs)
    const compositionEndMs = compositionStartMs + compositionDurationMs
    const segment = {
      type: 'video',
      id: stepId,
      stepId,
      kind: interactionKind,
      title,
      sourceVideo: context.options.sourceVideo,
      originalStartMs,
      originalEndMs,
      originalDurationMs,
      compositionStartMs,
      compositionEndMs,
      compositionDurationMs,
      overlay: interactionKind === 'click' ? {
        beforeMs: context.options.clickIndicator.beforeMs,
        afterMs: context.options.clickIndicator.afterMs,
        fadeMs: context.options.clickIndicator.fadeMs,
      } : null,
    }

    context.activeEntries.push(segment)
    context.compositionCursorMs = compositionEndMs
    context.videoSegmentCount += 1
    context.lastVideoStepId = stepId

    if (context.activeGroup) {
      if (context.activeGroup.firstVideoCompositionStartMs == null) {
        context.activeGroup.firstVideoCompositionStartMs = compositionStartMs
      }
      context.activeGroup.lastVideoCompositionEndMs = compositionEndMs
    }
    return
  }

  for (const child of node.children || []) {
    transformFlowNodeToEntries(child, context)
  }
}

function renderSequenceEntryXml(entry, indent) {
  if (entry.type === 'video') {
    return renderVideoSegmentXml(entry, indent)
  }

  if (entry.type === 'slide') {
    return [
      `${indent}<SlideSequence id="${toXmlAttr(entry.id)}" title="${toXmlAttr(entry.title)}">`,
      `${indent}  <Composition startMs="${entry.compositionStartMs}" endMs="${entry.compositionEndMs}" durationMs="${entry.compositionDurationMs}"/>`,
      `${indent}</SlideSequence>`,
    ]
  }

  if (entry.type === 'narration') {
    return renderNarrationSequenceXml(entry, indent)
  }

  if (entry.type === 'presentation') {
    return [
      `${indent}<PresentationSequence kind="${toXmlAttr(entry.kind)}" title="${toXmlAttr(entry.title)}">`,
      `${indent}  <Composition startMs="${entry.compositionStartMs}" endMs="${entry.compositionEndMs}" durationMs="${entry.compositionDurationMs}"/>`,
      `${indent}</PresentationSequence>`,
    ]
  }

  if (entry.type === 'freeze-extension') {
    return [
      `${indent}<FreezeFrameExtension afterGroupId="${toXmlAttr(entry.afterGroupId)}" ttsId="${toXmlAttr(entry.ttsId)}" durationMs="${entry.durationMs}">`,
      `${indent}  <Composition startMs="${entry.compositionStartMs}" endMs="${entry.compositionEndMs}" durationMs="${entry.compositionDurationMs}"/>`,
      `${indent}</FreezeFrameExtension>`,
    ]
  }

  if (entry.type === 'missing') {
    return [
      `${indent}<MissingTimelineStep resolvedId="${toXmlAttr(entry.resolvedId)}" title="${toXmlAttr(entry.title)}"/>`,
    ]
  }

  if (entry.type === 'skipped') {
    return [
      `${indent}<SkippedTimelineStep stepId="${toXmlAttr(entry.stepId)}" status="${toXmlAttr(entry.status)}" skipped="true"/>`,
    ]
  }

  return [`${indent}<!-- Unsupported sequence entry omitted -->`]
}

export function renderRemotionScenarioXmlTemplate({
  resolvedXmlSource,
  stepTimeline,
  options = {},
}) {
  const root = parseResolvedXmlElementTree(resolvedXmlSource)
  const scenarioId = String(firstDefined(root.attrs, ['id'], 'scenario') || 'scenario')
  const scenarioTitle = sanitizeSensitiveText(String(firstDefined(root.attrs, ['title', 'titel'], scenarioId) || scenarioId))
  const fps = Math.max(1, normalizedMs(options.fps, 30))
  const width = Math.max(1, normalizedMs(options.width, 1280))
  const height = Math.max(1, normalizedMs(options.height, 720))

  const transformOptions = {
    sourceVideo: String(options.sourceVideo || 'recording.mp4'),
    sourceTimeline: String(options.sourceTimeline || 'scenario-step-timeline.json'),
    defaultVoice: String(options.defaultVoice || 'de-DE'),
    clickIndicator: {
      beforeMs: normalizedMs(options?.clickIndicator?.beforeMs, 800),
      afterMs: normalizedMs(options?.clickIndicator?.afterMs, 100),
      fadeMs: normalizedMs(options?.clickIndicator?.fadeMs, 50),
    },
  }

  const timeline = buildTimelineIndex(stepTimeline)

  const context = {
    timeline,
    options: transformOptions,
    sequences: [],
    activeEntries: [],
    activeGroup: null,
    compositionCursorMs: 0,
    lastVideoStepId: null,
    ttsAssets: [],
    validationErrors: [],
    videoSegmentCount: 0,
    missingTimelineStepCount: 0,
    ttsCounter: 0,
    slideCounter: 0,
  }
  context.activeEntries = context.sequences

  for (const child of root.children || []) {
    transformFlowNodeToEntries(child, context)
  }

  const lines = []
  lines.push(`<RemotionSzenario id="${toXmlAttr(scenarioId)}" title="${toXmlAttr(scenarioTitle)}">`)
  lines.push('  <Assets>')
  lines.push(`    <SourceVideo src="${toXmlAttr(transformOptions.sourceVideo)}"/>`)
  lines.push(`    <SourceTimeline src="${toXmlAttr(transformOptions.sourceTimeline)}"/>`)
  for (const tts of context.ttsAssets) {
    lines.push(`    <TTS id="${toXmlAttr(tts.id)}" text="${toXmlAttr(tts.text)}" voice="${toXmlAttr(tts.voice)}"/>`)
  }
  lines.push('  </Assets>')
  lines.push('')
  lines.push(`  <Composition fps="${fps}" width="${width}" height="${height}">`)
  lines.push('    <Sequenzen>')

  for (const sequence of context.sequences) {
    if (sequence.type === 'chapter') {
      lines.push(`      <Chapter id="${toXmlAttr(sequence.id)}" title="${toXmlAttr(sequence.title)}" narration.mode="${toXmlAttr(sequence.narrationMode)}" allowExtendGroup="${sequence.allowExtendGroup ? 'true' : 'false'}">`)
      for (const child of sequence.entries || []) {
        lines.push(...renderSequenceEntryXml(child, '        '))
      }
      lines.push('      </Chapter>')
      continue
    }

    lines.push(...renderSequenceEntryXml(sequence, '      '))
  }

  for (const runtimeBlock of timeline.runtimeBlocks) {
    lines.push(`      <RuntimeBlock startMs="${runtimeBlock.startedAtMs}" endMs="${runtimeBlock.endedAtMs}" durationMs="${runtimeBlock.durationMs}" status="${toXmlAttr(runtimeBlock.status)}"/>`)
  }

  for (const validationError of context.validationErrors) {
    lines.push(`      <ValidationError code="${toXmlAttr(validationError.code)}" groupId="${toXmlAttr(validationError.groupId || '')}" ttsId="${toXmlAttr(validationError.ttsId || '')}">${toXmlText(validationError.message || '')}</ValidationError>`)
  }

  lines.push('    </Sequenzen>')
  lines.push('  </Composition>')
  lines.push('')
  lines.push('  <Summary>')
  lines.push(`    <OriginalDurationMs>${timeline.originalDurationMs}</OriginalDurationMs>`)
  lines.push(`    <CompositionDurationMs>${context.compositionCursorMs}</CompositionDurationMs>`)
  lines.push(`    <VideoSegmentCount>${context.videoSegmentCount}</VideoSegmentCount>`)
  lines.push(`    <TTSCount>${context.ttsAssets.length}</TTSCount>`)
  lines.push(`    <MissingTimelineStepCount>${context.missingTimelineStepCount}</MissingTimelineStepCount>`)
  lines.push('  </Summary>')
  lines.push('</RemotionSzenario>')
  lines.push('')

  return lines.join('\n')
}

function slugify(input) {
  return String(input || 'scenario')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'scenario'
}

function toLiteral(value) {
  return JSON.stringify(value)
}

function countRenderedSteps(flowEntries) {
  let count = 0

  for (const step of flowEntries || []) {
    count += 1
    if (Array.isArray(step?.flow) && step.flow.length > 0) {
      count += countRenderedSteps(step.flow)
    }
    if (Array.isArray(step?.elseFlow) && step.elseFlow.length > 0) {
      count += countRenderedSteps(step.elseFlow)
    }
  }

  return count
}

function hasUsableScrollTarget(target) {
  if (!target || typeof target !== 'object') {
    return false
  }

  if (target.testid || target.id || target['data-id'] || target.text || target.role) {
    return true
  }

  return targetNeedsRuntimeLocator(target) || Boolean(buildGenericTargetSelector(target))
}

function buildScrollTargetSummary(target) {
  if (!target || typeof target !== 'object') {
    return ''
  }

  const fields = ['testid', 'data-id', 'id', 'role', 'text', 'label', 'aria-label', 'selektor-regex', 'treffer-index', 'komponententyp']
  const parts = []

  for (const field of fields) {
    const value = target[field]
    if (value == null) {
      continue
    }

    const text = String(value).replace(/\s+/g, ' ').trim()
    if (!text) {
      continue
    }

    parts.push(`${field}=${text}`)
  }

  const selector = buildGenericTargetSelector(target)
  if (selector) {
    parts.push(`selector=${selector}`)
  }

  return parts.join(' | ')
}

function buildTargetSelectorDescriptions(target) {
  if (!target || typeof target !== 'object') {
    return []
  }

  const rawRegexFlag = target['selektor-regex']
  const regexEnabled = rawRegexFlag === true || ['true', '1', 'yes'].includes(String(rawRegexFlag || '').trim().toLowerCase())
  const fields = ['testid', 'data-id', 'id', 'role', 'text', 'label', 'aria-label', 'selektor-regex', 'treffer-index', 'komponententyp', 'click_child_selector']
  const selectors = []

  for (const field of fields) {
    const value = target[field]
    if (value == null) {
      continue
    }

    const text = String(value).replace(/\s+/g, ' ').trim()
    if (!text) {
      continue
    }

    if (regexEnabled && ['testid', 'data-id', 'text', 'label', 'aria-label'].includes(field)) {
      selectors.push(`${field}=/${text}/`)
      continue
    }

    selectors.push(`${field}=${text}`)
  }

  const genericSelector = buildGenericTargetSelector(target)
  if (genericSelector) {
    selectors.push(`selector=${genericSelector}`)
  }

  return selectors
}

function buildTimelineStepDescription(step) {
  const stepTitle = typeof step?.resolvedTitle === 'string' ? step.resolvedTitle.trim() : ''
  const interaction = step?.interaction || {}
  const selectors = buildTargetSelectorDescriptions(interaction.target)
  const descriptionParts = []
  if (interaction.type === 'search-and-select' && interaction.resultSelector) {
    selectors.push(`resultSelector=${String(interaction.resultSelector).trim()}`)
  }
  if (interaction.type === 'read-ui-value' && interaction.output) {
    descriptionParts.push(`read->${String(interaction.output).trim()}`)
  }
  if (interaction.type === 'read-pin-brief-mail' && interaction.output) {
    descriptionParts.push(`mailhog->${String(interaction.output).trim()}`)
  }
  if (selectors.length > 0) {
    descriptionParts.push(`selectors: ${selectors.join(' ; ')}`)
  }

  if (descriptionParts.length === 0) {
    return stepTitle
  }

  return stepTitle
    ? `${stepTitle} | ${descriptionParts.join(' | ')}`
    : descriptionParts.join(' | ')
}

function buildStepMeta(step) {
  const interaction = step?.interaction || {}
  const selectors = buildTargetSelectorDescriptions(interaction.target)
  if (interaction.type === 'search-and-select' && interaction.resultSelector) {
    selectors.push(`resultSelector=${String(interaction.resultSelector).trim()}`)
  }

  return {
    interactionType: interaction.type ? String(interaction.type) : null,
    selectors,
  }
}

function buildTargetAvailabilityLogLines(step, options = {}) {
  const interaction = step?.interaction || {}
  const target = interaction.target || {}
  const interactionType = String(interaction.type || '').trim().toLowerCase()
  const stepRuntimeRef = options.stepRuntimeRef || '__scenarioStep'
  const genericSelector = buildGenericTargetSelector(target)
  const lines = []
  const supportedInteractionTypes = new Set(['click', 'fill', 'append', 'replace', 'select', 'upload', 'scroll', 'assert', 'search-and-select'])

  if (!supportedInteractionTypes.has(interactionType) || !target || typeof target !== 'object' || Object.keys(target).length === 0) {
    return lines
  }

  if (target.url && Object.keys(target).every((key) => key === 'url' || key === 'state')) {
    return lines
  }

  const availabilityOptions = {}
  if (genericSelector) {
    availabilityOptions.genericSelector = genericSelector
  }

  if (interactionType === 'fill' || interactionType === 'append' || interactionType === 'replace' || interactionType === 'upload') {
    if (targetNeedsRuntimeLocator(target)) {
      availabilityOptions.textMode = 'label'
      availabilityOptions.preferredControl = 'fill'
    }
  } else if (interactionType === 'select') {
    if (targetNeedsRuntimeLocator(target) || target['data-id'] || target.label || target['aria-label']) {
      availabilityOptions.textMode = 'label'
      availabilityOptions.preferredControl = 'select'
    }
  } else if (interactionType === 'scroll') {
    if (targetNeedsRuntimeLocator(target) && !target.role) {
      availabilityOptions.textMode = 'label'
    }
  }

  lines.push(`const __scenarioTargetAvailability = await describeTargetAvailability(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, ${toLiteral(availabilityOptions)}).catch((error) => ({ count: 0, strategy: 'unresolved', selectors: [], error: String(error && error.message ? error.message : error) }))`)
  lines.push(`await ${stepRuntimeRef}.log("info", "target-availability", {`)
  lines.push(`  interactionType: ${toLiteral(interactionType)},`)
  lines.push('  availableCount: __scenarioTargetAvailability.count,')
  lines.push('  selectorStrategy: __scenarioTargetAvailability.strategy,')
  lines.push('  selectors: __scenarioTargetAvailability.selectors,')
  lines.push('  preferredControl: __scenarioTargetAvailability.preferredControl ?? null,')
  lines.push('  textMode: __scenarioTargetAvailability.textMode ?? null,')
  lines.push('  targetIndex: __scenarioTargetAvailability.targetIndex ?? null,')
  lines.push('  error: __scenarioTargetAvailability.error ?? null,')
  lines.push('})')

  return lines
}

function buildInjectedAutoScrollResolvedTitle(step) {
  const interaction = step?.interaction || {}
  const targetSummary = buildScrollTargetSummary(interaction.target)
  const sourceTitle = String(step?.resolvedTitle || '').replace(/\s+/g, ' ').trim()
  const sourceStepId = String(step?.resolvedId || step?.id || '').trim()
  const parts = ['Scroll']

  if (targetSummary) {
    parts.push(targetSummary)
  }
  if (sourceStepId) {
    parts.push(`origin=${sourceStepId}`)
  }
  if (sourceTitle) {
    parts.push(`source=${sourceTitle}`)
  }

  const title = parts.join(' | ')
  return title.length > 220 ? `${title.slice(0, 217)}...` : title
}

function buildScrollLocatorExpression(target) {
  if (!target || typeof target !== 'object') {
    return null
  }

  if (targetNeedsRuntimeLocator(target)) {
    return `await resolveTargetLocator(page, ${buildTargetObjectExpression(target)}, { textMode: 'text' })`
  }

  if (target.text) {
    if (target.role) {
      return buildIndexedLocatorExpression(
        `page.getByRole(${toLiteral(String(target.role))}, { name: ${toLiteral(String(target.text))}, exact: true })`,
        target,
      )
    }
    return buildIndexedLocatorExpression(
      `page.getByText(${toLiteral(String(target.text))}, { exact: true })`,
      target,
    )
  }

  if (target.testid) {
    return buildIndexedLocatorExpression(`page.getByTestId(${toLiteral(String(target.testid))})`, target)
  }

  const genericSelector = buildGenericTargetSelector(target)
  if (genericSelector) {
    return buildIndexedLocatorExpression(`page.locator(${toLiteral(genericSelector)})`, target)
  }

  if (target['data-id'] || target.id) {
    const selectorType = target['data-id'] ? 'data-id' : 'id'
    const value = target['data-id'] || target.id
    const selector = selectorType === 'data-id'
      ? `[data-id=${JSON.stringify(String(value))}]`
      : `[id=${JSON.stringify(String(value))}]`
    return buildIndexedLocatorExpression(`page.locator(${toLiteral(selector)})`, target)
  }

  return null
}

function isInteractionTypeNeedingAutoScroll(interactionType) {
  return ['click', 'fill', 'append', 'replace', 'select', 'upload', 'search-and-select'].includes(interactionType)
}

function injectAutoScrollSteps(flowEntries, options = {}, path = []) {
  const enabled = options.enabled === true
  const injected = []

  for (let index = 0; index < (flowEntries || []).length; index += 1) {
    const step = flowEntries[index]
    const currentPath = [...path, index]
    const stepId = String(step?.id || slugify(`step-${currentPath.join('-')}`))
    const interaction = step?.interaction || {}
    const interactionType = String(interaction.type || '').trim().toLowerCase()

    if (enabled && isInteractionTypeNeedingAutoScroll(interactionType) && hasUsableScrollTarget(interaction.target)) {
      const onlyIfNotVisible = interactionType === 'select' ? false : true
      const injectedResolvedId = step?.resolvedId
        ? `${String(step.resolvedId).trim()}__autoscroll`
        : `${stepId}__autoscroll`
      injected.push({
        id: `${stepId}__autoscroll`,
        resolvedId: injectedResolvedId,
        resolvedTitle: buildInjectedAutoScrollResolvedTitle(step),
        if: step?.if,
        ifnot: step?.ifnot,
        interaction: {
          type: 'scroll',
          target: interaction.target,
          focus: false,
          only_if_not_visible: onlyIfNotVisible,
        },
      })
    }

    const nestedFlow = Array.isArray(step?.flow) ? step.flow : null
    const nestedElseFlow = Array.isArray(step?.elseFlow) ? step.elseFlow : null
    if (nestedFlow && nestedFlow.length > 0) {
      const nextStep = {
        ...step,
        flow: injectAutoScrollSteps(nestedFlow, options, currentPath),
      }
      if (nestedElseFlow && nestedElseFlow.length > 0) {
        nextStep.elseFlow = injectAutoScrollSteps(nestedElseFlow, options, currentPath)
      }
      injected.push(nextStep)
    } else if (nestedElseFlow && nestedElseFlow.length > 0) {
      injected.push({
        ...step,
        elseFlow: injectAutoScrollSteps(nestedElseFlow, options, currentPath),
      })
    } else {
      injected.push(step)
    }
  }

  return injected
}

function toConditionList(value, keyName, stepId) {
  if (value == null) {
    return []
  }

  if (Array.isArray(value)) {
    return value
  }

  if (typeof value === 'object') {
    return [value]
  }

  throw new Error(`Step "${stepId}" has invalid "${keyName}" guard. Use an object or array of objects.`)
}

function buildGenericTargetSelector(target) {
  const reservedKeys = new Set(['testid', 'id', 'data-id', 'text', 'role', 'url', 'state', 'click_child_selector', 'treffer-index', 'selektor-regex', 'label', 'aria-label', 'komponententyp'])
  const entries = Object.entries(target || {}).filter(([, value]) => value != null)
  const selectorParts = []

  for (const [key, value] of entries) {
    if (reservedKeys.has(key)) {
      continue
    }

    selectorParts.push(`[${key}=${JSON.stringify(String(value))}]`)
  }

  return selectorParts.length > 0 ? selectorParts.join('') : null
}

function targetNeedsRuntimeLocator(target) {
  return Boolean(target?.role || target?.['selektor-regex'] || target?.label || target?.['aria-label'] || target?.komponententyp)
}

function buildTargetObjectExpression(target, { runtimeVariables = false } = {}) {
  const entries = []

  for (const [key, rawValue] of Object.entries(target || {})) {
    if (rawValue == null) {
      continue
    }

    let valueExpression = null
    if (typeof rawValue === 'string') {
      valueExpression = runtimeVariables
        ? `resolveRuntimeTemplateString(${toLiteral(rawValue)}, runtimeVariables)`
        : toLiteral(rawValue)
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      valueExpression = JSON.stringify(rawValue)
    } else {
      valueExpression = toLiteral(String(rawValue))
    }

    entries.push(`${JSON.stringify(key)}: ${valueExpression}`)
  }

  return `{ ${entries.join(', ')} }`
}

function getTargetIndex(target) {
  const indexValue = Number(target?.['treffer-index'])
  return Number.isInteger(indexValue) ? indexValue : null
}

function buildIndexedLocatorExpression(baseExpression, target) {
  const index = getTargetIndex(target)
  if (index == null) {
    return `${baseExpression}.first()`
  }
  if (index >= 0) {
    return `${baseExpression}.nth(${index})`
  }
  return `(await pickIndexedLocator(${baseExpression}, ${index}))`
}

function buildExpectedResultAssertions(expectedResults) {
  const lines = []

  for (const rawResult of expectedResults || []) {
    const result = rawResult || {}
    const target = result.target || {}
    const state = result.state || target.state || {}

    if (targetNeedsRuntimeLocator(target)) {
      const locator = `await resolveTargetLocator(page, ${buildTargetObjectExpression(target)}, { textMode: 'text' })`

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
    } else if (target.testid) {
      const testId = String(target.testid)
      const locator = buildIndexedLocatorExpression(`page.getByTestId(${toLiteral(testId)})`, target)

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
    } else if (target.text) {
      const locator = target.role
        ? buildIndexedLocatorExpression(`page.getByRole(${toLiteral(String(target.role))}, { name: ${toLiteral(String(target.text))}, exact: true })`, target)
        : buildIndexedLocatorExpression(`page.getByText(${toLiteral(String(target.text))}, { exact: true })`, target)

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
    } else {
      const genericSelector = buildGenericTargetSelector(target)
      if (genericSelector) {
        const locator = buildIndexedLocatorExpression(`page.locator(${toLiteral(genericSelector)})`, target)

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
    }

    if (target.id) {
      const id = String(target.id)
      const locator = buildIndexedLocatorExpression(`page.locator(${toLiteral(`[id=${JSON.stringify(id)}]`)})`, target)

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
      const locator = buildIndexedLocatorExpression(`page.locator(${toLiteral(`[data-id=${JSON.stringify(dataId)}]`)})`, target)

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

function buildInteractionLines(step, options = {}) {
  const chapter = step?.chapter
  const chapterText = typeof chapter?.text === 'string' ? chapter.text.trim() : ''
  const hasChapter = chapter && typeof chapter === 'object' && !Array.isArray(chapter) && chapterText.length > 0
  const interaction = step.interaction || {}
  const interactionType = String(interaction.type || '').trim().toLowerCase()
  const target = interaction.target || {}
  const lines = []
  const scrollDelayRef = options.scrollDelayRef || '35'
  const smoothScrollEnabledRef = options.smoothScrollEnabledRef || 'false'
  const stepRuntimeRef = options.stepRuntimeRef || '__scenarioStep'

  if (!interactionType) {
    if (hasChapter) {
      // Chapter steps intentionally emit no browser interaction. The step still
      // exists in the timeline and is post-processed into a video title card.
      lines.push('await page.waitForTimeout(10)')
      return lines
    }
    throw new Error(`Step "${step.id}" defines neither an interaction nor a supported chapter block.`)
  }

  const targetAvailabilityLogLines = buildTargetAvailabilityLogLines(step, { stepRuntimeRef })
  for (const line of targetAvailabilityLogLines) {
    lines.push(line)
  }

  if (interactionType === 'open') {
    if (!target.url) {
      throw new Error(`Step "${step.id}" has interaction type "open" but no target.url.`)
    }
    lines.push(`await page.goto(${toLiteral(String(target.url))}, { waitUntil: 'networkidle' })`)
  } else if (interactionType === 'fill') {
    if (interaction.value == null && target.value != null) {
      throw new Error(
        `Step "${step.id}" has misplaced fill value. Put "value" under "interaction", not under "interaction.target".`
      )
    }
    if (targetNeedsRuntimeLocator(target)) {
      lines.push(`const __scenarioFillLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'label', preferredControl: 'fill' })`)
      lines.push(`await applyFillValueToLocator(page, __scenarioFillLocator, resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables), { targetLabel: ${toLiteral(buildScrollTargetSummary(target) || '<target>')} }, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true })`)
    } else if (target.testid) {
      lines.push(`await applyFillValue(page, ${toLiteral(String(target.testid))}, resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables), { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    } else if (target.text) {
      // Fill by visible text (first matching input/textarea/select)
      lines.push(`await ${buildIndexedLocatorExpression(`page.getByLabel(resolveRuntimeTemplateString(${toLiteral(String(target.text))}, runtimeVariables), { exact: true })`, target)}.fill(resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables))`)
    } else if (buildGenericTargetSelector(target)) {
      // Fill by generic selector
      lines.push(`await ${buildIndexedLocatorExpression(`page.locator(resolveRuntimeTemplateString(${toLiteral(buildGenericTargetSelector(target))}, runtimeVariables))`, target)}.fill(resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables))`)
    } else if (target.id || target['data-id']) {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyFillValueById(page, ${toLiteral(String(value))}, resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables), ${toLiteral(selectorType)}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    } else {
      throw new Error(`Step "${step.id}" has interaction type "fill" but no usable target fields.`)
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
    if (targetNeedsRuntimeLocator(target)) {
      lines.push(`const __scenarioAppendLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'label', preferredControl: 'fill' })`)
      lines.push(`await applyAppendValueToLocator(page, __scenarioAppendLocator, ${toLiteral(String(interaction.value || ''))}, { targetLabel: ${toLiteral(buildScrollTargetSummary(target) || '<target>')} })`)
    } else if (target.testid) {
      lines.push(`await applyAppendValue(page, ${toLiteral(String(target.testid))}, ${toLiteral(String(interaction.value || ''))}, { targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyAppendValueById(page, ${toLiteral(String(value))}, ${toLiteral(String(interaction.value || ''))}, ${toLiteral(selectorType)}, { targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    }
  } else if (interactionType === 'replace') {
    if (interaction.value == null && target.value != null) {
      throw new Error(
        `Step "${step.id}" has misplaced replace value. Put "value" under "interaction", not under "interaction.target".`
      )
    }
    if (interaction.searchValue == null || String(interaction.searchValue).trim() === '') {
      throw new Error(`Step "${step.id}" has interaction type "replace" but no searchValue.`)
    }
    const resolvedReplaceValueExpr = `resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables)`
    const resolvedSearchValueExpr = `resolveRuntimeTemplateString(${toLiteral(String(interaction.searchValue || ''))}, runtimeVariables)`
    const replaceOptionsExpr = `{ replaceRegex: ${interaction.replaceRegex === true ? 'true' : 'false'}, smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} }`
    if (targetNeedsRuntimeLocator(target)) {
      lines.push(`const __scenarioReplaceLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'label', preferredControl: 'fill' })`)
      lines.push(`await applyReplaceValueToLocator(page, __scenarioReplaceLocator, ${resolvedSearchValueExpr}, ${resolvedReplaceValueExpr}, { targetLabel: ${toLiteral(buildScrollTargetSummary(target) || '<target>')} }, { replaceRegex: ${interaction.replaceRegex === true ? 'true' : 'false'}, smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true })`)
    } else if (target.testid) {
      lines.push(`await applyReplaceValue(page, ${toLiteral(String(target.testid))}, ${resolvedSearchValueExpr}, ${resolvedReplaceValueExpr}, ${replaceOptionsExpr})`)
    } else if (target.text) {
      lines.push(`const __scenarioReplaceLabelLocator = ${buildIndexedLocatorExpression(`page.getByLabel(resolveRuntimeTemplateString(${toLiteral(String(target.text))}, runtimeVariables), { exact: true })`, target)}`)
      lines.push(`await applyReplaceValueToLocator(page, __scenarioReplaceLabelLocator, ${resolvedSearchValueExpr}, ${resolvedReplaceValueExpr}, { targetLabel: ${toLiteral(buildScrollTargetSummary(target) || '<target>')} }, { replaceRegex: ${interaction.replaceRegex === true ? 'true' : 'false'}, smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true })`)
    } else if (buildGenericTargetSelector(target)) {
      lines.push(`const __scenarioReplaceGenericLocator = ${buildIndexedLocatorExpression(`page.locator(resolveRuntimeTemplateString(${toLiteral(buildGenericTargetSelector(target))}, runtimeVariables))`, target)}`)
      lines.push(`await applyReplaceValueToLocator(page, __scenarioReplaceGenericLocator, ${resolvedSearchValueExpr}, ${resolvedReplaceValueExpr}, { targetLabel: ${toLiteral(buildScrollTargetSummary(target) || '<target>')} }, { replaceRegex: ${interaction.replaceRegex === true ? 'true' : 'false'}, smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true })`)
    } else if (target.id || target['data-id']) {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyReplaceValueById(page, ${toLiteral(String(value))}, ${resolvedSearchValueExpr}, ${resolvedReplaceValueExpr}, ${toLiteral(selectorType)}, ${replaceOptionsExpr})`)
    } else {
      throw new Error(`Step "${step.id}" has interaction type "replace" but no usable target fields.`)
    }
  } else if (interactionType === 'click') {
    if (!target.testid && !target.id && !target['data-id'] && !target.text && !target.role && !buildGenericTargetSelector(target)) {
      throw new Error(`Step "${step.id}" has interaction type "click" but no usable target fields.`)
    }
    if (targetNeedsRuntimeLocator(target)) {
      lines.push(`const __scenarioClickLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'text' })`)
      if (target.click_child_selector) {
        lines.push(`await __scenarioClickLocator.locator(${toLiteral(String(target.click_child_selector))}).first().click()`)
      } else {
        lines.push(`await applyClickValueToLocator(page, __scenarioClickLocator, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true }, { targetLabel: ${toLiteral(buildScrollTargetSummary(target) || '<target>')} })`)
      }
    } else if (target.text) {
      const textValue = toLiteral(String(target.text))
      if (target.role) {
        const baseLocator = buildIndexedLocatorExpression(`page.getByRole(${toLiteral(String(target.role))}, { name: ${textValue}, exact: true })`, target)
        if (target.click_child_selector) {
          lines.push(`await ${baseLocator}.locator(${toLiteral(String(target.click_child_selector))}).first().click()`)
        } else {
          lines.push(`await ${baseLocator}.click()`)
        }
      } else {
        const baseLocator = buildIndexedLocatorExpression(`page.getByText(${textValue}, { exact: true })`, target)
        if (target.click_child_selector) {
          lines.push(`await ${baseLocator}.locator(${toLiteral(String(target.click_child_selector))}).first().click()`)
        } else {
          lines.push(`await ${baseLocator}.click()`)
        }
      }
    } else if (target.testid) {
      lines.push(`const __scenarioClickLocator = ${buildIndexedLocatorExpression(`page.getByTestId(${toLiteral(String(target.testid))})`, target)}`)
      lines.push('await __scenarioClickLocator.click()')
    } else if (buildGenericTargetSelector(target)) {
      lines.push(`await applyClickValueBySelector(page, ${toLiteral(buildGenericTargetSelector(target))}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyClickValueById(page, ${toLiteral(String(value))}, ${toLiteral(selectorType)}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    }
  } else if (interactionType === 'select') {
    if (!target.testid && !target.id && !target['data-id'] && !targetNeedsRuntimeLocator(target)) {
      throw new Error(`Step "${step.id}" has interaction type "select" but no target.testid, target.id, target.data-id, role, label, aria-label, komponententyp, or selector-regex target.`)
    }
    if (interaction.value == null && target.value != null) {
      throw new Error(
        `Step "${step.id}" has misplaced select value. Put "value" under "interaction", not under "interaction.target".`
      )
    }
    if (targetNeedsRuntimeLocator(target)) {
      lines.push(`const __scenarioSelectLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'label', preferredControl: 'select' })`)
      lines.push(`await applySelectValueToLocator(page, __scenarioSelectLocator, ${toLiteral(String(interaction.value || ''))}, { targetLabel: ${toLiteral(buildScrollTargetSummary(target) || '<target>')} }, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true })`)
    } else if (target.testid) {
      lines.push(`await applySelectValue(page, ${toLiteral(String(target.testid))}, ${toLiteral(String(interaction.value || ''))}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applySelectValueById(page, ${toLiteral(String(value))}, ${toLiteral(String(interaction.value || ''))}, ${toLiteral(selectorType)}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    }
  } else if (interactionType === 'upload') {
    if (!target.testid && !target.id && !target['data-id'] && !targetNeedsRuntimeLocator(target) && !buildGenericTargetSelector(target)) {
      throw new Error(`Step "${step.id}" has interaction type "upload" but no usable target fields.`)
    }
    if (interaction.value == null || String(interaction.value).trim() === '') {
      throw new Error(`Step "${step.id}" has interaction type "upload" but no file value. Use the XML text content to name the file in neo/assets.`)
    }
    const resolvedFileExpr = `resolveRuntimeTemplateString(${toLiteral(String(interaction.value || ''))}, runtimeVariables)`
    if (targetNeedsRuntimeLocator(target)) {
      lines.push(`const __scenarioUploadLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'label' })`)
      lines.push(`await applyUploadValueToLocator(page, __scenarioUploadLocator, ${resolvedFileExpr}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true })`)
    } else if (target.testid) {
      lines.push(`await applyUploadValue(page, ${toLiteral(String(target.testid))}, ${resolvedFileExpr}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    } else if (buildGenericTargetSelector(target)) {
      lines.push(`await applyUploadValueById(page, ${toLiteral(buildGenericTargetSelector(target))}, ${resolvedFileExpr}, "selector", { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    } else {
      const selectorType = target['data-id'] ? 'data-id' : 'id'
      const value = target['data-id'] || target.id
      lines.push(`await applyUploadValueById(page, ${toLiteral(String(value))}, ${resolvedFileExpr}, ${toLiteral(selectorType)}, { smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true, targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
    }
  } else if (interactionType === 'scroll') {
    const focus = interaction.focus === true
    const onlyIfNotVisible = interaction.only_if_not_visible === true
    if (!target.testid && !target.id && !target['data-id'] && !target.text && !target.role && !targetNeedsRuntimeLocator(target) && !buildGenericTargetSelector(target)) {
      throw new Error(`Step "${step.id}" has interaction type "scroll" but no usable target fields.`)
    }
    const locatorExpression = buildScrollLocatorExpression(target)
    lines.push(`const __scenarioScrollResult = await scrollToLocator(page, ${locatorExpression}, { stepDelayMs: ${scrollDelayRef}, focus: ${focus ? 'true' : 'false'}, onlyIfNotVisible: ${onlyIfNotVisible ? 'true' : 'false'} })`)
    lines.push('if (!__scenarioScrollResult.didScroll) {')
    lines.push(`  return { __scenarioStepStatus: 'noop', reason: 'scroll target already in view' }`)
    lines.push('}')
  } else if (interactionType === 'wait') {
    const hasConditionTarget = target && typeof target === 'object' && Object.keys(target).length > 0
    const hasUntilCondition = interaction.until && typeof interaction.until === 'object' && !Array.isArray(interaction.until)
    const durationCandidate = interaction.ms ?? interaction.value ?? (!hasConditionTarget && !hasUntilCondition ? interaction.wait_ms : null)

    if (durationCandidate != null) {
      const durationMs = Number(durationCandidate)
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(`Step "${step.id}" has interaction type "wait" with invalid duration. Use interaction.ms as a non-negative number.`)
      }
      lines.push(`await page.waitForTimeout(${Math.floor(durationMs)})`)
    }

    const untilCondition = hasUntilCondition
      ? interaction.until
      : (hasConditionTarget ? { target, state: interaction.state || target.state || {} } : null)

    if (untilCondition) {
      const timeoutCandidate = interaction.timeout_ms ?? interaction.wait_until_timeout_ms ?? interaction.wait_ms ?? untilCondition?.state?.wait_ms ?? 5000
      const pollCandidate = interaction.poll_ms ?? 100
      const timeoutMs = Number(timeoutCandidate)
      const pollMs = Number(pollCandidate)

      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(`Step "${step.id}" has interaction type "wait" with invalid timeout_ms.`)
      }

      if (!Number.isFinite(pollMs) || pollMs <= 0) {
        throw new Error(`Step "${step.id}" has interaction type "wait" with invalid poll_ms.`)
      }

      lines.push(`await waitForCondition(page, ${toLiteral(untilCondition)}, ${Math.floor(timeoutMs)}, ${Math.max(25, Math.floor(pollMs))})`)
    }

    if (durationCandidate == null && !untilCondition) {
      throw new Error(`Step "${step.id}" has interaction type "wait" but no waiting criteria. Use interaction.ms and/or interaction.target with interaction.state (or interaction.until).`)
    }
  } else if (interactionType === 'assert') {
    if (target.url) {
      const expectedUrl = interaction.value ?? target.url
      lines.push(`await expect(page).toHaveURL(${toLiteral(String(expectedUrl))})`)
    } else {
      if (!target.testid && !target.id && !target['data-id'] && !targetNeedsRuntimeLocator(target)) {
        throw new Error(`Step "${step.id}" has interaction type "assert" but no target.testid, target.id, target.data-id, role, label, aria-label, komponententyp, selector-regex target, or target.url.`)
      }

      if (interaction.value == null && target.value != null) {
        throw new Error(
          `Step "${step.id}" has misplaced assert value. Put "value" under "interaction", not under "interaction.target".`
        )
      }

      const expectedValue = interaction.value ?? ''
      if (targetNeedsRuntimeLocator(target)) {
        lines.push(`const __scenarioAssertLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'label' })`)
        lines.push(`await assertElementValueByLocator(__scenarioAssertLocator, ${toLiteral(String(expectedValue))}, ${toLiteral(buildScrollTargetSummary(target) || '<target>')})`)
      } else if (target.testid) {
        lines.push(`await assertElementValueByTestId(page, ${toLiteral(String(target.testid))}, ${toLiteral(String(expectedValue))}, { targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
      } else {
        const selectorType = target['data-id'] ? 'data-id' : 'id'
        const value = target['data-id'] || target.id
        lines.push(`await assertElementValueById(page, ${toLiteral(String(value))}, ${toLiteral(String(expectedValue))}, ${toLiteral(selectorType)}, { targetIndex: ${getTargetIndex(target) ?? 'undefined'} })`)
      }
    }
  } else if (interactionType === 'search-and-select') {
    if (!target['data-id']) {
      throw new Error(`Step "${step.id}" has interaction type "search-and-select" but no target.data-id.`)
    }
    if (!interaction.value) {
      throw new Error(`Step "${step.id}" has interaction type "search-and-select" but no value.`)
    }
    if (!interaction.resultSelector) {
      throw new Error(`Step "${step.id}" has interaction type "search-and-select" but no resultSelector.`)
    }
    const dataId = String(target['data-id'])
    const value = String(interaction.value)
    const resultSelector = String(interaction.resultSelector)
    const resultIndex = interaction.resultIndex != null ? Number(interaction.resultIndex) : 0
    lines.push(`await searchAndSelect(page, { target: { 'data-id': ${toLiteral(dataId)} }, value: ${toLiteral(value)}, resultSelector: ${toLiteral(resultSelector)}, resultIndex: ${resultIndex}, smoothScroll: ${smoothScrollEnabledRef}, stepDelayMs: ${scrollDelayRef}, skipAutoScroll: true })`)
    // Assertion falls vorhanden
    if (interaction.assert) {
      lines.push(...buildExpectedResultAssertions([interaction.assert]))
    }
    return lines

  } else if (interactionType === 'extract-pdf-code') {
    // Custom interaction: extract code from PDF and assign to variable
    const regex = interaction.auslesenRegex
    const output = interaction.output || 'extractedCode'
    if (!regex) {
      throw new Error(`Step "${step.id}" with type extract-pdf-code requires auslesenRegex.`)
    }
    const pdfPathExpression = interaction.pdfPath
      ? `resolveRuntimeTemplateString(${toLiteral(String(interaction.pdfPath))}, runtimeVariables)`
      : `testInfo.outputPath(${toLiteral(`${String(step.id || 'extract-pdf')}.pdf`)})`
    lines.push(`const effectiveDownload = lastDownload ?? await page.waitForEvent('download', { timeout: 5000 }).catch(() => null)`)
    lines.push(`const effectivePdfResponse = lastPdfResponse ?? await page.waitForResponse((response) => String(response.headers()['content-type'] || '').includes('application/pdf'), { timeout: 5000 }).catch(() => null)`)
    lines.push(`const extractedValue = await extractCodeFromPdf(${pdfPathExpression}, new RegExp(resolveRuntimeTemplateString(${toLiteral(String(regex))}, runtimeVariables)), { download: effectiveDownload, response: effectivePdfResponse })`)
    lines.push(`setRuntimeVariable(runtimeVariables, ${toLiteral(String(output))}, extractedValue)`)
  } else if (interactionType === 'read-ui-value') {
    const output = String(interaction.output || '').trim()
    const source = String(interaction.source || 'text').trim().toLowerCase()
    if (!output) {
      throw new Error(`Step "${step.id}" with type read-ui-value requires output.`)
    }
    if (!target || Object.keys(target).length === 0) {
      throw new Error(`Step "${step.id}" with type read-ui-value requires a target.`)
    }
    if (source === 'url') {
      lines.push('const __scenarioReadValue = page.url()')
      lines.push(`setRuntimeVariable(runtimeVariables, ${toLiteral(output)}, __scenarioReadValue)`)
      lines.push(`__scenarioStep.info("runtime-variable-set", { output: ${toLiteral(output)}, value: __scenarioReadValue, source: ${toLiteral(source)} })`)
      lines.push(`console.log("[scenario-read]", ${toLiteral(output)}, "=", __scenarioReadValue)`)
    } else {
      lines.push(`const __scenarioReadLocator = await resolveTargetLocator(page, ${buildTargetObjectExpression(target, { runtimeVariables: true })}, { textMode: 'text' })`)
      lines.push(`const __scenarioReadValue = await __scenarioReadLocator.evaluate((element, payload) => {
  const sourceType = String(payload.source || 'text')
  const tagName = String(element?.tagName || '').toLowerCase()
  const inputType = String(element?.getAttribute?.('type') || '').toLowerCase()
  if (sourceType === 'value') {
    return String(element?.value ?? element?.getAttribute?.('value') ?? '')
  }
  if (sourceType === 'text') {
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || inputType === 'text') {
      return String(element?.value ?? element?.getAttribute?.('value') ?? '')
    }
    return String(element?.innerText ?? element?.textContent ?? '').trim()
  }
  return ''
}, { source: ${toLiteral(source)} })`)
      lines.push(`setRuntimeVariable(runtimeVariables, ${toLiteral(output)}, __scenarioReadValue)`)
      lines.push(`__scenarioStep.info("runtime-variable-set", { output: ${toLiteral(output)}, value: __scenarioReadValue, source: ${toLiteral(source)} })`)
      lines.push(`console.log("[scenario-read]", ${toLiteral(output)}, "=", __scenarioReadValue)`)
    }
  } else if (interactionType === 'read-pin-brief-mail') {
    const output = String(interaction.output || '').trim()
    const url = String(interaction.url || '').trim()
    const vornamen = String(interaction.vornamen || '').trim()
    const familienname = String(interaction.familienname || '').trim()
    const zeilenIndex = interaction.zeilenIndex
    if (!output) {
      throw new Error(`Step "${step.id}" with type read-pin-brief-mail requires output.`)
    }
    if (!url) {
      throw new Error(`Step "${step.id}" with type read-pin-brief-mail requires url.`)
    }
    if ((zeilenIndex == null || zeilenIndex === '') && (!vornamen || !familienname)) {
      throw new Error(`Step "${step.id}" with type read-pin-brief-mail requires either zeilenIndex or vornamen and familienname.`)
    }
    lines.push(`const __scenarioMailhogUrl = resolveRuntimeTemplateString(${toLiteral(url)}, runtimeVariables)`)
    lines.push(`const __scenarioActivationCode = await readActivationCodeFromMailhog({ mailhogUrl: __scenarioMailhogUrl, vornamen: ${vornamen ? `resolveRuntimeTemplateString(${toLiteral(vornamen)}, runtimeVariables)` : '""'}, familienname: ${familienname ? `resolveRuntimeTemplateString(${toLiteral(familienname)}, runtimeVariables)` : '""'}, zeilenIndex: ${zeilenIndex == null ? 'null' : Number(zeilenIndex)} })`)
    lines.push(`setRuntimeVariable(runtimeVariables, ${toLiteral(output)}, __scenarioActivationCode)`)
    lines.push(`__scenarioStep.info("runtime-variable-set", { output: ${toLiteral(output)}, value: __scenarioActivationCode, source: "mailhog" })`)
    lines.push(`console.log("[scenario-read]", ${toLiteral(output)}, "=", __scenarioActivationCode)`)
  } else if (interactionType === 'set-runtime-variable') {
    const output = interaction.output
    if (!output) {
      throw new Error(`Step "${step.id}" with type set-runtime-variable requires output.`)
    }
    lines.push(`setRuntimeVariable(runtimeVariables, ${toLiteral(String(output))}, resolveRuntimeTemplateString(${toLiteral(String(interaction.value ?? ''))}, runtimeVariables))`)
  } else {
    throw new Error(`Unsupported interaction type "${interactionType}" in step "${step.id}".`)
  }

  return lines
}

export function renderScenarioSpecTemplate({
  resolvedRoot,
  scenarioPathRelative,
  envFillStrategiesImportPath = null,
}) {
  const baseFlow = Array.isArray(resolvedRoot?.flow) ? resolvedRoot.flow : []
  const autoScrollSmoothEnabled = resolvedRoot?.video?.autoscroll_smooth === true
  const flow = injectAutoScrollSteps(baseFlow, { enabled: true })
  if (!flow.length) {
    throw new Error('Scenario contains no flow steps.')
  }

  const scenarioName = String(resolvedRoot.id || basename(scenarioPathRelative))
  const scenarioVersion = String(resolvedRoot.version || 'unknown')
  const stepIdentifierLogEnabledByScenario = resolvedRoot?.debug?.log_step_identifiers === true
  const waitBetweenStepsMs = Number(resolvedRoot?.video?.wait_between_steps ?? 0)
  const scrollDelayMs = Number(resolvedRoot?.video?.scroll_delay_ms ?? 35)
  const scrollStepPx = Number(resolvedRoot?.video?.scroll_step_px ?? 20)
  const stepTimeoutMs = Number(resolvedRoot?.runtime?.step_timeout_ms ?? 30000)
  const smoothScrollEnabled = autoScrollSmoothEnabled
  const renderedStepCount = Math.max(1, countRenderedSteps(flow))
  const actionBudgetMs = renderedStepCount * 3500
  const pacingBudgetMs = renderedStepCount * Math.max(0, Math.floor(waitBetweenStepsMs))
  const dynamicTestTimeoutMs = Math.max(30000, actionBudgetMs + pacingBudgetMs + 10000)
  const describeTitle = `Scenario: ${scenarioName}`
  const testTitle = `runs generated flow for ${scenarioName}`

  const parts = []
  parts.push(...getScenarioSpecImports())
  parts.push(...getScenarioSpecSetupLines({
    envFillStrategiesImportPath,
    scrollStepPx: Number.isFinite(scrollStepPx) ? Math.max(1, Math.floor(scrollStepPx)) : 20,
  }))

  // Add describe and test start
  parts.push('')
  parts.push(`test.describe(${toLiteral(describeTitle)}, () => {`)
  parts.push(`  test(${toLiteral(testTitle)}, async ({ page }, testInfo) => {`)
  parts.push('    const videoModeEnabled = process.env.SCENARIO_VIDEO_MODE === "1"')
  parts.push(`    test.setTimeout(${dynamicTestTimeoutMs})`)
  parts.push(`    const waitBetweenStepsMs = ${Number.isFinite(waitBetweenStepsMs) ? Math.max(0, Math.floor(waitBetweenStepsMs)) : 0}`)
  parts.push(`    const scrollDelayMs = ${Number.isFinite(scrollDelayMs) ? Math.max(0, Math.floor(scrollDelayMs)) : 35}`)
  parts.push(`    const stepTimeoutMs = ${Number.isFinite(stepTimeoutMs) ? Math.max(0, Math.floor(stepTimeoutMs)) : 30000}`)
  parts.push(`    const smoothScrollEnabled = ${smoothScrollEnabled ? 'true' : 'false'}`)
  parts.push(`    const stepIdentifierLogEnabledByScenario = ${stepIdentifierLogEnabledByScenario ? 'true' : 'false'}`)
  parts.push('    const stepIdentifierLogEnabledByEnv = process.env.SCENARIO_STEP_DOM_LOG === "1" || process.env.SCENARIO_STEP_DOM_LOG === "true"')
  parts.push('    const stepIdentifierLogEnabled = stepIdentifierLogEnabledByScenario || stepIdentifierLogEnabledByEnv')
  parts.push('    const runtimeVariables = {}')
  parts.push('    let lastDownload = null')
  parts.push('    let lastPdfResponse = null')
  parts.push('    page.on("download", (download) => { lastDownload = download })')
  parts.push('    page.on("response", (response) => {')
  parts.push('      if (String(response.headers()["content-type"] || "").includes("application/pdf")) {')
  parts.push('        lastPdfResponse = response')
  parts.push('      }')
  parts.push('    })')
  parts.push('    const timelineRuntime = createScenarioTimelineRuntime({')
  parts.push('      test,')
  parts.push('      testInfo,')
  parts.push(`      scenarioId: ${toLiteral(scenarioName)},`)
  parts.push(`      scenarioVersion: ${toLiteral(scenarioVersion)},`)
  parts.push(`      scenarioSource: ${toLiteral(String(scenarioPathRelative))},`)
  parts.push('      page,')
  parts.push('      videoModeEnabled,')
  parts.push('      waitBetweenStepsMs,')
  parts.push('      stepTimeoutMs,')
  parts.push('    })')
  parts.push('    const stepIdentifierLogger = createStepDomIdentifierLogger({ page, testInfo, enabled: stepIdentifierLogEnabled })')
  parts.push('')
  parts.push('    try {')

  function emitFlowSteps(steps, indent = '    ') {
    for (const step of steps) {
      const stepDidactics = step?.didactics || step?.didactic || {}
      const purposeText = typeof stepDidactics?.purpose?.text === 'string'
        ? String(stepDidactics.purpose.text).replace(/\s+/g, ' ').trim()
        : ''
      const interaction = step?.interaction || {}
      const interactionType = String(interaction.type || '').trim().toLowerCase()
      const stepId = typeof step?.resolvedId === 'string' ? step.resolvedId.trim() : '';
      const stepTitle = typeof step?.resolvedTitle === 'string' ? step.resolvedTitle.trim() : ''
      const stepDescription = buildTimelineStepDescription(step)
      const stepMeta = buildStepMeta(step)

      const conditionalCondition = step?.condition && typeof step.condition === 'object' ? step.condition : null
      const conditionalThenFlow = Array.isArray(step?.flow) ? step.flow : []
      const conditionalElseFlow = Array.isArray(step?.elseFlow) ? step.elseFlow : []
      const isConditionalBranchStep = Boolean(
        conditionalCondition
        && (conditionalThenFlow.length > 0 || conditionalElseFlow.length > 0)
      )

      const ifConditions = toConditionList(step.if, 'if', stepId)
      const ifNotConditions = toConditionList(step.ifnot, 'ifnot', stepId)

      parts.push(`${indent}await timelineRuntime.runStep(${toLiteral(stepId)}, ${toLiteral(stepDescription)}, async (__scenarioStep) => {`)
      if (stepId || stepTitle) {
        parts.push(`${indent}  // ${[stepId, stepTitle].filter(Boolean).join(' | ')}`)
      }
      parts.push(`${indent}  // ${stepTitle}`)
      parts.push(`${indent}  await stepIdentifierLogger.capture(${toLiteral(stepId)}, "before")`)

      if (isConditionalBranchStep) {
        parts.push(`${indent}  const __scenarioConditionMet = await shouldRunStepFromGuards(page, ${toLiteral({ if: [conditionalCondition], ifnot: [] })})`)
        parts.push(`${indent}  if (__scenarioConditionMet) {`)
        if (conditionalThenFlow.length > 0) {
          emitFlowSteps(conditionalThenFlow, `${indent}    `)
        } else {
          parts.push(`${indent}    await stepIdentifierLogger.capture(${toLiteral(stepId)}, "skipped", { reason: "conditional then-branch empty" })`)
          parts.push(`${indent}    return { __scenarioStepStatus: 'skipped', reason: 'conditional then-branch empty' }`)
        }
        parts.push(`${indent}  } else {`)
        if (conditionalElseFlow.length > 0) {
          emitFlowSteps(conditionalElseFlow, `${indent}    `)
        } else {
          parts.push(`${indent}    await stepIdentifierLogger.capture(${toLiteral(stepId)}, "skipped", { reason: "condition not met and no else branch" })`)
          parts.push(`${indent}    return { __scenarioStepStatus: 'skipped', reason: 'condition not met and no else branch' }`)
        }
        parts.push(`${indent}  }`)
        parts.push('')
      } else if (ifConditions.length > 0 || ifNotConditions.length > 0) {
        parts.push(`${indent}  const shouldRunStep = await shouldRunStepFromGuards(page, ${toLiteral({ if: ifConditions, ifnot: ifNotConditions })})`)
        parts.push(`${indent}  if (!shouldRunStep) {`)
        parts.push(`${indent}    await stepIdentifierLogger.capture(${toLiteral(stepId)}, "skipped", { reason: "if/ifnot guard condition not met" })`)
        parts.push(`${indent}    return { __scenarioStepStatus: 'skipped', reason: 'if/ifnot guard condition not met' }`)
        parts.push(`${indent}  }`)
        parts.push('')
      }

      const nestedFlow = Array.isArray(step.flow) ? step.flow : []
      if (isConditionalBranchStep) {
        // Branch flow is emitted above.
      } else if (nestedFlow.length > 0) {
        emitFlowSteps(nestedFlow, `${indent}  `)
      } else {
        const interactionLines = buildInteractionLines(step, { scrollDelayRef: 'scrollDelayMs', smoothScrollEnabledRef: 'smoothScrollEnabled', stepRuntimeRef: '__scenarioStep' })
        for (const line of interactionLines) {
          parts.push(`${indent}  ${line}`)
        }

        const assertionLines = buildExpectedResultAssertions(step.expected_results)
        for (const line of assertionLines) {
          parts.push(`${indent}  ${line}`)
        }
      }

      parts.push(`${indent}  await stepIdentifierLogger.capture(${toLiteral(stepId)}, "after")`)
      parts.push(`${indent}}, ${toLiteral(stepMeta)})`)
      parts.push('')
    }
  }

  emitFlowSteps(flow, '    ')

  parts.push('    } finally {')
  parts.push('      await stepIdentifierLogger.flush()')
  parts.push('      await timelineRuntime.flush()')
  parts.push('    }')
  parts.push('  })')
  parts.push('})')
  parts.push('')

  return parts.join('\n')
}
