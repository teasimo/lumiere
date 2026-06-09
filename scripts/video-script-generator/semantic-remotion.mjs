import { dirname, relative, resolve } from 'path'

// Toggle click marker behavior in generated Remotion plans.
// true: click steps are represented via freeze/pause windows.
// false: click steps use visual marker overlays without injected freezes.
const CLICKMARKER_FREEZE = true

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function humanizeStepTitle(value) {
  return String(value || '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function synthAnonChapterId(idPrefix, index) {
  return `__anon-chapter-${idPrefix ? `${idPrefix}:` : ''}${index}`
}

function flattenFlowSteps(flowEntries, out = [], idPrefix = '') {
  for (let index = 0; index < (flowEntries || []).length; index += 1) {
    const step = flowEntries[index]
    if (!step || typeof step !== 'object') {
      continue
    }

    const resolvedId = String(step.resolvedId || '').trim()
    const rawStepId = String(step.id || '').trim()
    const stepId = resolvedId || rawStepId
    if (!stepId) {
      if (step.chapter) {
        out.push({
          id: synthAnonChapterId(idPrefix, index),
          step,
          isIncludeContainer: false,
          isSyntheticId: true,
        })
      }
      continue
    }

    const fullId = resolvedId
      ? stepId
      : (idPrefix ? `${idPrefix}-${stepId}` : stepId)
    out.push({
      id: fullId,
      step,
      isIncludeContainer: Boolean(step.include),
      isSyntheticId: false,
    })

    if (Array.isArray(step.flow) && step.flow.length > 0) {
      flattenFlowSteps(step.flow, out, fullId)
    }
  }

  return out
}

function resolvePresentationStepWindowMs(stepId, timelineSteps) {
  const normalizedStepId = String(stepId || '').trim()
  if (!normalizedStepId) {
    return null
  }

  const exactMatches = timelineSteps.filter((entry) => String(entry?.stepId || '').trim() === normalizedStepId)
  const prefixMatches = timelineSteps.filter((entry) => String(entry?.stepId || '').trim().startsWith(`${normalizedStepId}-`))
  const matches = exactMatches.length > 0 ? exactMatches : prefixMatches
  if (matches.length === 0) {
    return null
  }

  let minStartedAt = Number.POSITIVE_INFINITY
  let maxEndedAt = Number.NEGATIVE_INFINITY
  for (const match of matches) {
    const startedAtMs = Number(match?.startedAtMs)
    const endedAtMs = Number(match?.endedAtMs)
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
      continue
    }
    minStartedAt = Math.min(minStartedAt, startedAtMs)
    maxEndedAt = Math.max(maxEndedAt, endedAtMs)
  }

  if (!Number.isFinite(minStartedAt) || !Number.isFinite(maxEndedAt)) {
    return null
  }

  return {
    startedAtMs: minStartedAt,
    endedAtMs: maxEndedAt,
  }
}

function resolveNeighborWindowForAnonStep(stepId, flattenedFlowStepEntries, sortedTimelineSteps) {
  const entryIndex = flattenedFlowStepEntries.findIndex((entry) => entry.id === stepId)
  if (entryIndex < 0) return null

  for (let index = entryIndex + 1; index < flattenedFlowStepEntries.length; index += 1) {
    if (flattenedFlowStepEntries[index].isSyntheticId) continue
    const window = resolvePresentationStepWindowMs(flattenedFlowStepEntries[index].id, sortedTimelineSteps)
    if (window) return window
  }

  for (let index = entryIndex - 1; index >= 0; index -= 1) {
    if (flattenedFlowStepEntries[index].isSyntheticId) continue
    const window = resolvePresentationStepWindowMs(flattenedFlowStepEntries[index].id, sortedTimelineSteps)
    if (window) return window
  }

  return null
}

function buildStepWindowMap({ scenarioRoot, timelineReport, presentationRange = null }) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const timelineSteps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  const flattenedFlowStepEntries = flattenFlowSteps(flow)
  const sortedTimelineSteps = [...timelineSteps].sort((left, right) => Number(left?.startedAtMs || 0) - Number(right?.startedAtMs || 0))
  let timelineOriginMs = 0
  for (const timelineStep of sortedTimelineSteps) {
    const startedAtMs = Number(timelineStep?.startedAtMs)
    if (Number.isFinite(startedAtMs) && startedAtMs >= 0) {
      timelineOriginMs = startedAtMs
      break
    }
  }

  const clipStartMs = presentationRange
    ? Math.max(0, Number(presentationRange.startMs) || 0)
    : 0
  const clipEndMs = presentationRange?.endMs == null
    ? null
    : Math.max(clipStartMs, Number(presentationRange.endMs) || clipStartMs)
  const stepWindowById = new Map()

  for (const flowEntry of flattenedFlowStepEntries) {
    let window = resolvePresentationStepWindowMs(flowEntry.id, sortedTimelineSteps)
    if (!window && flowEntry.isSyntheticId) {
      window = resolveNeighborWindowForAnonStep(flowEntry.id, flattenedFlowStepEntries, sortedTimelineSteps)
    }
    if (!window) {
      continue
    }

    // Das sind die Parameter, die bestimmen, welche Zeit vor und nach einem Interaktion aus dem Video übernommen wird
    const timeToShowBeforeInteraction = 500;
    const timeToShowAfterInteraction = 500;

    const timelineRelativeStartMs = Math.max(0, Math.floor(window.startedAtMs - timelineOriginMs))
    const timelineRelativeEndMs = Math.max(
      timelineRelativeStartMs,
      Math.floor(window.endedAtMs - timelineOriginMs + timeToShowAfterInteraction),
    )

    const unclippedWindowStartMs = Math.max(0, timelineRelativeStartMs - timeToShowBeforeInteraction)
    const unclippedWindowEndMs = Math.max(unclippedWindowStartMs + 1, timelineRelativeEndMs)
    const clipWindowStartMs = clipStartMs
    const clipWindowEndMs = clipEndMs == null
      ? Number.POSITIVE_INFINITY
      : clipEndMs

    if (unclippedWindowEndMs <= clipWindowStartMs || unclippedWindowStartMs >= clipWindowEndMs) {
      continue
    }

    const clippedWindowStartMs = Math.max(unclippedWindowStartMs, clipWindowStartMs)
    const clippedWindowEndMs = Math.min(unclippedWindowEndMs, clipWindowEndMs)
    // Keep step clip windows in normalized source-video time (ms from source start),
    // while preserving the presentation clip offset.
    const sourceStartMs = Math.max(0, clippedWindowStartMs)
    const sourceEndMs = Math.max(sourceStartMs + 1, clippedWindowEndMs)

    stepWindowById.set(flowEntry.id, {
      sourceStartMs,
      sourceEndMs,
      originalStartMs: Math.max(0, Math.floor(window.startedAtMs)),
      originalEndMs: Math.max(0, Math.floor(window.endedAtMs)),
    })
  }

  return {
    flattenedFlowStepEntries,
    stepWindowById,
  }
}

function buildNarrationGroups(adjustedAudioFiles) {
  const narrationsByStepId = new Map()
  const pausesByStepId = new Map()

  for (const entry of Array.isArray(adjustedAudioFiles) ? adjustedAudioFiles : []) {
    const stepId = String(entry?.sourceScenarioStepId || entry?.sourceTimelineStepId || '').trim()
    if (!stepId) {
      continue
    }

    if (!narrationsByStepId.has(stepId)) {
      narrationsByStepId.set(stepId, [])
    }
    const rawFile = String(entry?.file || '').trim()
    narrationsByStepId.get(stepId).push({
      id: String(entry?.id || stepId),
      file: rawFile ? resolve(rawFile) : null,
      atMs: Math.max(0, Math.floor(Number(entry?.finalOutputStartMs != null ? entry.finalOutputStartMs : entry?.startMs || 0))),
      channel: String(entry?.sourceChannel || '').trim() || undefined,
    })

    const overflowMs = Math.max(0, Math.floor(Number(entry?.overflowMs || 0)))
    const pauseAtMs = Number(entry?.pauseAtMs)
    if (overflowMs <= 0 || !Number.isFinite(pauseAtMs)) {
      continue
    }

    if (!pausesByStepId.has(stepId)) {
      pausesByStepId.set(stepId, [])
    }
    pausesByStepId.get(stepId).push({
      atSourceMs: Math.max(0, Math.floor(pauseAtMs)),
      durationMs: overflowMs,
    })
  }

  return {
    narrationsByStepId,
    pausesByStepId,
  }
}

function groupClickMarkersByStep(stepWindowById, clickMarkers, markerSourceOffsetMs = 0) {
  const sourceOffsetMs = Math.max(0, Math.floor(Number(markerSourceOffsetMs) || 0))
  const clickMarkersByStepId = new Map()
  for (const [stepId, window] of stepWindowById.entries()) {
    const markers = (Array.isArray(clickMarkers) ? clickMarkers : [])
      .filter((marker) => {
        const markerAtMs = Math.max(0, Math.round(Number(marker?.at || 0) * 1000) + sourceOffsetMs)
        return markerAtMs >= window.sourceStartMs && markerAtMs <= window.sourceEndMs
      })
      .map((marker) => ({
        atSourceMs: Math.max(0, Math.round(Number(marker?.at || 0) * 1000) + sourceOffsetMs),
        x: Math.max(0, Number(marker?.x || 0)),
        y: Math.max(0, Number(marker?.y || 0)),
        durationMs: Math.max(1, Math.floor(Number(marker?.durationMs || 900))),
      }))

    clickMarkersByStepId.set(stepId, markers)
  }

  return clickMarkersByStepId
}

function buildStepTagMap(stepWindowById, stepSegments) {
  const tagMap = new Map()
  for (const [stepId, window] of stepWindowById.entries()) {
    const tags = (Array.isArray(stepSegments) ? stepSegments : [])
      .filter((segment) => {
        const segmentStartMs = Math.max(0, Math.round(Number(segment?.start || 0) * 1000))
        const segmentEndMs = Math.max(segmentStartMs, Math.round(Number(segment?.end || 0) * 1000))
        return segmentEndMs >= window.sourceStartMs && segmentStartMs <= window.sourceEndMs
      })
      .map((segment) => String(segment?.label || '').trim())
      .filter(Boolean)
    tagMap.set(stepId, tags)
  }
  return tagMap
}

function toChapterCardCallout(chapterCard, slideDefaults = null) {
  if (!chapterCard || typeof chapterCard !== 'object') {
    return []
  }

  const slideText = String(chapterCard.slideText || '').trim()
  if (slideText) {
    const slideCallout = toSlideCallout({
      text: slideText,
      durationMs: chapterCard.durationMs,
      fontSize: chapterCard.fontSize,
      'row-index': chapterCard?.['row-index'] ?? null,
    }, slideDefaults)
    return slideCallout ? [slideCallout] : []
  }

  return [{
    text: String(chapterCard.title || chapterCard.text || '').trim(),
    atMs: 0,
    durationMs: Math.max(1, Math.floor(Number(chapterCard.durationMs || 1))),
    variant: 'chapter-card',
    'row-index': chapterCard?.['row-index'] ?? null,
    fontSize: Number(chapterCard.fontSize) || 54,
    textYStart: Number.isFinite(Number(chapterCard.textYStart)) ? Math.floor(Number(chapterCard.textYStart)) : null,
    lineSpacing: Number.isFinite(Number(chapterCard.lineSpacing)) ? Math.floor(Number(chapterCard.lineSpacing)) : null,
  }].filter((entry) => entry.text)
}

function toSlideCallout(slide, slideDefaults = null) {
  if (!slide || typeof slide !== 'object') {
    return null
  }

  const text = String(slide.title || slide.text || '').trim()
  if (!text) {
    return null
  }

  const rawDuration = Number(slide.duration_ms ?? slide.durationMs)
  const defaultDurationMs = Math.max(1, Math.floor(Number(slideDefaults?.defaultDurationMs) || 2000))
  const durationMs = Math.max(1, Number.isFinite(rawDuration) ? Math.floor(rawDuration) : defaultDurationMs)
  const rawFontSize = Number(slide.font_size ?? slide.fontSize)
  const fontSize = Math.max(1, Number.isFinite(rawFontSize) ? Math.floor(rawFontSize) : 64)

  return {
    text,
    atMs: 0,
    durationMs,
    variant: 'slide-card',
    fontSize,
    logoLeft: resolve('neo/assets/kultusministerium-logo.png'),
    logoRight: resolve('neo/assets/neo-logo.svg'),
    'row-index': slide?.['row-index'] ?? null,
  }
}

function toStepOverlayCallout({ chapterTitle, stepTitle, durationMs, rowIndex }) {
  const chapter = String(chapterTitle || '').trim()
  const step = String(stepTitle || '').trim()
  const text = [chapter, step].filter(Boolean).join(' :: ')
  if (!text) {
    return null
  }

  return {
    text,
    atMs: 0,
    durationMs: Math.max(1, Math.floor(Number(durationMs) || 1)),
    variant: 'step-overlay',
    'row-index': rowIndex ?? null,
  }
}


function mapInteractionKind(interactionType) {
  const normalized = String(interactionType || '').trim().toLowerCase()
  if (!normalized) return 'unknown'
  if (normalized === 'search-and-select') return 'search-select'
  return normalized
}

function estimateTtsDurationMs(text, explicitDurationMs = null) {
  const explicit = Number(explicitDurationMs)
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(300, Math.floor(explicit))
  }

  const wordCount = String(text || '').trim().split(/\s+/).filter(Boolean).length
  const wordsPerMinute = 180
  const msPerWord = 60000 / wordsPerMinute
  return Math.max(1200, Math.round(wordCount * msPerWord))
}

function buildTimelineIndex(timelineReport) {
  const steps = Array.isArray(timelineReport?.steps) ? timelineReport.steps : []
  const byStepId = new Map()
  let minStartMs = Number.POSITIVE_INFINITY
  let maxEndMs = Number.NEGATIVE_INFINITY

  for (const step of steps) {
    const stepId = String(step?.stepId || '').trim()
    const startedAtMs = Math.max(0, Math.floor(Number(step?.startedAtMs || 0)))
    const endedAtMs = Math.max(startedAtMs, Math.floor(Number(step?.endedAtMs || startedAtMs)))
    const durationMs = Math.max(0, Math.floor(Number(step?.durationMs || (endedAtMs - startedAtMs))))
    const status = String(step?.status || '').trim() || 'unknown'
    const skipped = step?.skipped === true || status.toLowerCase() === 'skipped'

    minStartMs = Math.min(minStartMs, startedAtMs)
    maxEndMs = Math.max(maxEndMs, endedAtMs)

    if (!stepId) {
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

    const mergedStartMs = Math.min(existing.startedAtMs, startedAtMs)
    const mergedEndMs = Math.max(existing.endedAtMs, endedAtMs)
    byStepId.set(stepId, {
      stepId,
      startedAtMs: mergedStartMs,
      endedAtMs: mergedEndMs,
      durationMs: Math.max(0, mergedEndMs - mergedStartMs),
      status: existing.status,
      skipped: existing.skipped && skipped,
    })
  }

  const originalDurationMs = Number.isFinite(minStartMs) && Number.isFinite(maxEndMs)
    ? Math.max(0, maxEndMs - minStartMs)
    : 0

  return {
    byStepId,
    originalDurationMs,
  }
}

function buildChapterSwitchMap({ chapterCards, flattenedFlowStepEntries }) {
  const byStepId = new Map()
  const chapters = []
  let sequence = 0

  for (const card of Array.isArray(chapterCards) ? chapterCards : []) {
    const anchorStepId = String(card?.sourceScenarioStepId || '').trim()
    const title = String(card?.title || card?.text || '').trim()
    if (!anchorStepId || !title) {
      continue
    }

    sequence += 1
    const chapterId = `chapter-${sequence}`
    byStepId.set(anchorStepId, {
      id: chapterId,
      title,
    })
    chapters.push({ id: chapterId, title })
  }

  if (chapters.length === 0) {
    for (const entry of flattenedFlowStepEntries) {
      const chapterText = String(entry?.step?.chapter?.text || '').trim()
      if (!chapterText) {
        continue
      }

      sequence += 1
      const chapterId = `chapter-${sequence}`
      byStepId.set(String(entry?.id || '').trim(), {
        id: chapterId,
        title: chapterText,
      })
      chapters.push({ id: chapterId, title: chapterText })
    }
  }

  if (chapters.length === 0) {
    chapters.push({ id: 'chapter-1', title: 'Kapitel 1' })
  }

  return {
    byStepId,
    chapters,
  }
}

function buildTtsByStepId(adjustedAudioFiles) {
  const byStepId = new Map()

  for (const entry of Array.isArray(adjustedAudioFiles) ? adjustedAudioFiles : []) {
    const stepId = String(entry?.sourceScenarioStepId || entry?.sourceTimelineStepId || '').trim()
    if (!stepId) {
      continue
    }

    if (!byStepId.has(stepId)) {
      byStepId.set(stepId, [])
    }

    const text = String(entry?.text || entry?.plainText || entry?.id || '').trim()
    const audioDurationMs = Math.max(0, Math.floor(Number(entry?.audioDurationMs || 0)))
    const startMs = Math.max(0, Math.floor(Number(entry?.finalOutputStartMs != null ? entry.finalOutputStartMs : entry?.startMs || 0)))
    const endMs = Math.max(startMs, Math.floor(Number(entry?.finalOutputEndMs != null ? entry.finalOutputEndMs : entry?.endMs || startMs)))
    const explicitDurationMs = endMs > startMs ? (endMs - startMs) : audioDurationMs

    byStepId.get(stepId).push({
      id: String(entry?.id || `${stepId}-tts`),
      text,
      voice: String(entry?.voice || 'de-DE'),
      mode: String(entry?.mode || 'freeze').trim().toLowerCase() === 'parallel-group' ? 'parallel-group' : 'freeze',
      durationMs: estimateTtsDurationMs(text, explicitDurationMs),
    })
  }

  return byStepId
}

export function buildCanonicalVideoCompositionModel({
  scenarioRoot,
  timelineReport,
  chapterCards = [],
  adjustedAudioFiles = [],
  clickMarkers = [],
  inputVideo,
  width,
  height,
  fps,
  clickIndicator = null,
  slideDefaults = null,
}) {
  const flow = Array.isArray(scenarioRoot?.flow) ? scenarioRoot.flow : []
  const { flattenedFlowStepEntries, stepWindowById } = buildStepWindowMap({
    scenarioRoot,
    timelineReport,
    presentationRange: null,
  })
  const timelineIndex = buildTimelineIndex(timelineReport)
  const ttsByStepId = buildTtsByStepId(adjustedAudioFiles)
  const chapterSwitchMap = buildChapterSwitchMap({
    chapterCards,
    flattenedFlowStepEntries,
  })
  const clickMarkersByStepId = groupClickMarkersByStep(stepWindowById, clickMarkers)
  const clickPresentation = {
    freezeBeforeMs: Math.max(0, Math.floor(Number(clickIndicator?.beforeMs || 800))),
    highlightDurationMs: Math.max(0, Math.floor(Number(clickIndicator?.highlightDurationMs || 300))),
    afterMs: Math.max(0, Math.floor(Number(clickIndicator?.afterMs || 100))),
    fadeMs: Math.max(0, Math.floor(Number(clickIndicator?.fadeMs || 50))),
  }

  const timeline = []
  const chapters = [...chapterSwitchMap.chapters]
  let currentChapterId = chapters[0]?.id || 'chapter-1'
  let compositionCursorMs = 0
  let videoSegments = 0
  let slides = 0
  let ttsBlocks = 0
  let audioBlocks = 0
  let imageBlocks = 0
  let missingSteps = 0

  if (!flow.length) {
    return {
      schemaVersion: '1.0',
      video: {
        width: Number(width) || 1280,
        height: Number(height) || 720,
        fps: Number(fps) || 30,
      },
      assets: {
        sourceVideo: resolve(String(inputVideo || 'recording.mp4')),
      },
      chapters,
      timeline,
      summary: {
        originalDurationMs: timelineIndex.originalDurationMs,
        compositionDurationMs: compositionCursorMs,
        videoSegments,
        slides,
        ttsBlocks,
        audioBlocks,
        imageBlocks,
        missingSteps,
      },
    }
  }

  for (const flowEntry of flattenedFlowStepEntries) {
    const flowStepId = String(flowEntry?.id || '').trim()
    if (!flowStepId) {
      continue
    }

    const chapterSwitch = chapterSwitchMap.byStepId.get(flowStepId)
    if (chapterSwitch) {
      currentChapterId = chapterSwitch.id
    }

    const step = flowEntry?.step || {}
    if (flowEntry.isSyntheticId || step.chapter) {
      continue
    }

    const stepId = String(step?.resolvedId || flowStepId).trim()
    if (!stepId) {
      continue
    }

    const timelineStep = timelineIndex.byStepId.get(stepId)
    if (!timelineStep) {
      timeline.push({
        type: 'missing-step',
        stepId,
        chapterId: currentChapterId,
      })
      missingSteps += 1
      continue
    }

    if (timelineStep.skipped) {
      timeline.push({
        type: 'skipped-step',
        chapterId: currentChapterId,
        stepId,
        reason: timelineStep.status || 'skipped',
      })
      continue
    }

    const interaction = step?.interaction || {}
    const kind = mapInteractionKind(interaction.type)
    const title = String(step?.resolvedTitle || humanizeStepTitle(step?.title || stepId) || stepId)

    const sourceDurationMs = Math.max(0, Number(timelineStep.durationMs || (timelineStep.endedAtMs - timelineStep.startedAtMs)))
    let compositionDurationMs = Math.max(1, Math.floor(sourceDurationMs))

    const segment = {
      type: 'video-segment',
      stepId,
      title,
      'row-index': step?.['row-index'] ?? null,
      kind,
      chapterId: currentChapterId,
      source: {
        startMs: Math.max(0, Math.floor(timelineStep.startedAtMs)),
        endMs: Math.max(0, Math.floor(timelineStep.endedAtMs)),
        durationMs: Math.max(0, Math.floor(sourceDurationMs)),
      },
      composition: {
        startMs: compositionCursorMs,
        endMs: compositionCursorMs + compositionDurationMs,
        durationMs: compositionDurationMs,
      },
    }

    let segmentClickMarkers = [...(clickMarkersByStepId.get(stepId) || [])]
    if (kind === 'click') {
      const extensionMs = clickPresentation.freezeBeforeMs + clickPresentation.highlightDurationMs + clickPresentation.afterMs
      if (extensionMs > 0 && CLICKMARKER_FREEZE) {
        compositionDurationMs += extensionMs
        segment.composition = {
          startMs: compositionCursorMs,
          endMs: compositionCursorMs + compositionDurationMs,
          durationMs: compositionDurationMs,
        }
        segment.interactionPresentation = {
          mode: 'freeze-highlight-click',
          freezeBeforeMs: clickPresentation.freezeBeforeMs,
          highlightDurationMs: clickPresentation.highlightDurationMs,
          afterMs: clickPresentation.afterMs,
          fadeMs: clickPresentation.fadeMs,
        }

        const primaryMarker = segmentClickMarkers[0] || null
        if (primaryMarker) {
          const clickAtSourceMs = Math.max(0, Number(primaryMarker.atSourceMs || 0))
          const holdAtSourceMs = Math.max(
            Math.max(0, Number(segment.source.startMs || 0)),
            clickAtSourceMs - clickPresentation.freezeBeforeMs,
          )
          segmentClickMarkers[0] = {
            ...primaryMarker,
            atSourceMs: holdAtSourceMs,
            durationMs: Math.max(1, clickPresentation.highlightDurationMs + clickPresentation.afterMs),
          }
        }
      }
    }

    if (segmentClickMarkers.length > 0) {
      const sourceStartMs = Math.max(0, Number(segment.source.startMs || 0))
      segment.clickMarkers = segmentClickMarkers.map((marker) => {
        const atSourceMs = Math.max(0, Number(marker?.atSourceMs || 0))
        const relativeSourceMs = Math.max(0, atSourceMs - sourceStartMs)
        return {
          ...marker,
          atSourceMs,
          atCompositionMs: Math.max(0, segment.composition.startMs + relativeSourceMs),
        }
      })
    }

    timeline.push(segment)
    compositionCursorMs += compositionDurationMs
    videoSegments += 1

    const stepTtsEntries = ttsByStepId.get(stepId) || []
    for (const ttsEntry of stepTtsEntries) {
      const ttsDurationMs = Math.max(300, Math.floor(Number(ttsEntry.durationMs || 0)))
      const ttsBlock = {
        type: 'tts',
        chapterId: currentChapterId,
        'row-index': step?.['row-index'] ?? null,
        mode: ttsEntry.mode,
        afterStepId: stepId,
        text: ttsEntry.text,
        voice: ttsEntry.voice || 'de-DE',
      }

      if (ttsEntry.mode === 'parallel-group') {
        ttsBlock.composition = {
          startMs: segment.composition.startMs,
          endMs: segment.composition.endMs,
          durationMs: segment.composition.durationMs,
        }
      } else {
        ttsBlock.composition = {
          startMs: compositionCursorMs,
          endMs: compositionCursorMs + ttsDurationMs,
          durationMs: ttsDurationMs,
        }
        compositionCursorMs += ttsDurationMs
      }

      timeline.push(ttsBlock)
      ttsBlocks += 1
    }

    const inlineSlide = step?.slide && typeof step.slide === 'object' ? step.slide : null
    if (inlineSlide) {
      const inlineDefaultDurationMs = Math.max(1, Math.floor(Number(slideDefaults?.inlineDefaultDurationMs) || 3000))
      const slideDurationMs = Math.max(1, Math.floor(Number(inlineSlide.durationMs || inlineDefaultDurationMs)))
      timeline.push({
        type: 'slide',
        chapterId: currentChapterId,
        'row-index': inlineSlide?.['row-index'] ?? step?.['row-index'] ?? null,
        title: String(inlineSlide.title || 'Folie'),
        durationMs: slideDurationMs,
        composition: {
          startMs: compositionCursorMs,
          endMs: compositionCursorMs + slideDurationMs,
          durationMs: slideDurationMs,
        },
      })
      compositionCursorMs += slideDurationMs
      slides += 1
    }

    const inlineAudio = step?.audio && typeof step.audio === 'object' ? step.audio : null
    if (inlineAudio) {
      const durationMs = Math.max(0, Math.floor(Number(inlineAudio.durationMs || 0)))
      const startMode = String(inlineAudio.startMode || 'parallel').trim() || 'parallel'
      const startMs = startMode === 'parallel'
        ? Math.max(0, segment.composition.startMs)
        : compositionCursorMs
      timeline.push({
        type: 'audio',
        chapterId: currentChapterId,
        'row-index': step?.['row-index'] ?? null,
        src: String(inlineAudio.src || '').trim(),
        startMode,
        composition: {
          startMs,
          endMs: startMs + durationMs,
          durationMs,
        },
      })
      if (startMode !== 'parallel') {
        compositionCursorMs += durationMs
      }
      audioBlocks += 1
    }

    const inlineImage = step?.image && typeof step.image === 'object' ? step.image : null
    if (inlineImage) {
      const durationMs = Math.max(1, Math.floor(Number(inlineImage.durationMs || 5000)))
      timeline.push({
        type: 'image',
        chapterId: currentChapterId,
        'row-index': step?.['row-index'] ?? null,
        src: String(inlineImage.src || '').trim(),
        durationMs,
        composition: {
          startMs: compositionCursorMs,
          endMs: compositionCursorMs + durationMs,
          durationMs,
        },
      })
      compositionCursorMs += durationMs
      imageBlocks += 1
    }
  }

  return {
    schemaVersion: '1.0',
    video: {
      width: Number(width) || 1280,
      height: Number(height) || 720,
      fps: Number(fps) || 30,
    },
    assets: {
      sourceVideo: resolve(String(inputVideo || 'recording.mp4')),
    },
    chapters,
    timeline,
    summary: {
      originalDurationMs: timelineIndex.originalDurationMs,
      compositionDurationMs: compositionCursorMs,
      videoSegments,
      slides,
      ttsBlocks,
      audioBlocks,
      imageBlocks,
      missingSteps,
    },
  }
}

export function buildSemanticVideoPlan({
  scenarioRoot,
  timelineReport,
  presentationRange = null,
  chapterCards = [],
  clickMarkers = [],
  clickIndicator = null,
  stepSegments = [],
  adjustedAudioFiles = [],
  inputVideo,
  outputVideo,
  width,
  height,
  fps,
  slideDefaults = null,
  videoIntro = null,
}) {
  const { flattenedFlowStepEntries, stepWindowById } = buildStepWindowMap({
    scenarioRoot,
    timelineReport,
    presentationRange,
  })
  const { narrationsByStepId, pausesByStepId } = buildNarrationGroups(adjustedAudioFiles)
  const clickMarkerSourceOffsetMs = presentationRange
    ? Math.max(0, Number(presentationRange.startMs) || 0)
    : 0
  const clickMarkersByStepId = groupClickMarkersByStep(stepWindowById, clickMarkers, clickMarkerSourceOffsetMs)
  const tagMap = buildStepTagMap(stepWindowById, stepSegments)
  const chapterCardById = new Map((Array.isArray(chapterCards) ? chapterCards : []).map((entry) => [String(entry?.sourceScenarioStepId || '').trim(), entry]))
  const clickPresentation = {
    freezeBeforeMs: Math.max(0, Math.floor(Number(clickIndicator?.beforeMs || 800))),
    highlightDurationMs: Math.max(0, Math.floor(Number(clickIndicator?.highlightDurationMs || 300))),
    afterMs: Math.max(0, Math.floor(Number(clickIndicator?.afterMs || 100))),
    fadeMs: Math.max(0, Math.floor(Number(clickIndicator?.fadeMs || 50))),
  }

  const defaultChapterTitle = String(scenarioRoot?.title || scenarioRoot?.id || 'Video').trim() || 'Video'
  const chapters = []
  let currentChapter = {
    id: 'chapter-1',
    title: defaultChapterTitle,
    steps: [],
  }

  function ensureCurrentChapter() {
    if (!currentChapter) {
      currentChapter = {
        id: `chapter-${chapters.length + 1}`,
        title: defaultChapterTitle,
        steps: [],
      }
    }
    if (!chapters.includes(currentChapter)) {
      chapters.push(currentChapter)
    }
  }

  for (const flowEntry of flattenedFlowStepEntries) {
    const stepId = String(flowEntry?.id || '').trim()
    if (!stepId) {
      continue
    }

    if (flowEntry.isSyntheticId || flowEntry?.step?.chapter) {
      const chapterCard = chapterCardById.get(stepId) || null
      currentChapter = {
        id: stepId,
        title: String(chapterCard?.title || chapterCard?.text || flowEntry?.step?.chapter?.text || defaultChapterTitle).trim() || defaultChapterTitle,
        'row-index': flowEntry?.step?.chapter?.['row-index'] ?? flowEntry?.step?.['row-index'] ?? chapterCard?.['row-index'] ?? null,
        steps: [],
      }
      chapters.push(currentChapter)

      const chapterNarrations = narrationsByStepId.get(stepId) || []
      const chapterPauses = pausesByStepId.get(stepId) || []
      const chapterWindow = stepWindowById.get(stepId) || null
      if (chapterCard || chapterNarrations.length > 0) {
        currentChapter.steps.push({
          id: `${stepId}--intro`,
          title: currentChapter.title,
          'row-index': flowEntry?.step?.['row-index'] ?? chapterCard?.['row-index'] ?? null,
          tags: [],
          clip: {
            sourceStartMs: Math.max(0, Number(chapterWindow?.sourceStartMs || 0)),
            sourceEndMs: Math.max(1, Number(chapterWindow?.sourceStartMs || 0) + 1000),
          },
          freezes: [],
          pauses: chapterPauses,
          narrations: chapterNarrations,
          callouts: toChapterCardCallout(chapterCard, slideDefaults),
          clickMarkers: [],
        })
      }
      continue
    }

    const window = stepWindowById.get(stepId)
    if (!window) {
      continue
    }

    ensureCurrentChapter()
    const interactionType = String(flowEntry?.step?.interaction?.type || '').trim().toLowerCase()
    const basePauses = [...(pausesByStepId.get(stepId) || [])]
    const baseMarkers = [...(clickMarkersByStepId.get(stepId) || [])]

    const holdDurationMs = clickPresentation.freezeBeforeMs + clickPresentation.highlightDurationMs + clickPresentation.afterMs
    if (holdDurationMs > 0 && CLICKMARKER_FREEZE && baseMarkers.length > 0) {
      const primaryMarker = baseMarkers[0]
      const clickAtSourceMs = Math.max(0, Number(primaryMarker.atSourceMs || 0))
      const holdAtSourceMs = Math.max(
        Math.max(0, Number(window.sourceStartMs || 0)),
        clickAtSourceMs - clickPresentation.freezeBeforeMs,
      )

      basePauses.push({
        atSourceMs: holdAtSourceMs,
        durationMs: holdDurationMs,
      })

      baseMarkers[0] = {
        ...primaryMarker,
        atSourceMs: holdAtSourceMs,
        durationMs: Math.max(1, clickPresentation.highlightDurationMs + clickPresentation.afterMs),
      }
    }

    const rowIndex = flowEntry?.step?.['row-index'] ?? null
    const markersWithRowIndex = baseMarkers.map((marker) => ({
      ...marker,
      'row-index': marker?.['row-index'] ?? rowIndex,
    }))

    const slideCallout = toSlideCallout(flowEntry?.step?.slide, slideDefaults)
    if (slideCallout) {
      currentChapter.steps.push({
        id: `${stepId}--slide`,
        title: slideCallout.text,
        'row-index': slideCallout['row-index'] ?? rowIndex,
        tags: [],
        clip: {
          sourceStartMs: window.sourceStartMs,
          sourceEndMs: Math.max(window.sourceStartMs + 1, window.sourceStartMs + 1),
        },
        freezes: [],
        pauses: [{
          atSourceMs: window.sourceStartMs,
          durationMs: slideCallout.durationMs,
        }],
        narrations: [],
        callouts: [slideCallout],
        clickMarkers: [],
      })
    }

    const stepTitle = humanizeStepTitle(flowEntry?.step?.title || stepId) || stepId
    const stepDurationMs = Math.max(
      1,
      (Math.max(1, Number(window.sourceEndMs || 1)) - Math.max(0, Number(window.sourceStartMs || 0)))
      + basePauses.reduce((sum, pause) => sum + Math.max(0, Number(pause?.durationMs || 0)), 0),
    )
    const stepOverlay = toStepOverlayCallout({
      chapterTitle: currentChapter?.title,
      stepTitle,
      durationMs: stepDurationMs,
      rowIndex,
    })

    currentChapter.steps.push({
      id: stepId,
      title: stepTitle,
      'row-index': rowIndex,
      tags: tagMap.get(stepId) || [],
      clip: {
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
      },
      freezes: [],
      pauses: basePauses,
      narrations: narrationsByStepId.get(stepId) || [],
      callouts: stepOverlay ? [stepOverlay] : [],
      clickMarkers: markersWithRowIndex,
    })
  }

  const filteredChapters = chapters.filter((chapter) => Array.isArray(chapter.steps) && chapter.steps.length > 0)

  return {
    planVersion: '1.0',
    id: String(scenarioRoot?.id || 'video-script').trim() || 'video-script',
    version: scenarioRoot?.version ?? 'unknown',
    title: defaultChapterTitle,
    meta: {
      generatedAt: new Date().toISOString(),
      outputVideo: resolve(String(outputVideo || '')),
    },
    source: {
      videoPath: resolve(String(inputVideo || '')),
      introVideoPath: videoIntro?.path ? resolve(String(videoIntro.path)) : null,
      introDurationMs: Math.max(0, Math.floor(Number(videoIntro?.durationMs || 0))),
      fps: Number(fps) || 30,
      width: Number(width) || 1280,
      height: Number(height) || 720,
    },
    chapters: filteredChapters,
  }
}

function renderJsxText(value) {
  return JSON.stringify(String(value || ''))
}

export function buildSemanticRemotionTsx({ semanticPlan, outputFilePath, runtimeFilePath, debugOverlay = false }) {
  const runtimeImportPath = normalizeImportSpecifier(relative(dirname(outputFilePath), runtimeFilePath))
  const introProps = []
  if (semanticPlan?.source?.introVideoPath) {
    introProps.push(`introVideo={__stagedAsset(${renderJsxText(semanticPlan.source.introVideoPath)})}`)
    introProps.push(`introDurationMs={${Math.max(0, Number(semanticPlan?.source?.introDurationMs || 0))}}`)
  }
  const introPropsSegment = introProps.length > 0 ? ` ${introProps.join(' ')}` : ''
  const lines = [
    "import React from 'react'",
    "import {",
    '  VideoScript,',
    '  Chapter,',
    '  Step,',
    '  Clip,',
    '  Freeze,',
    '  Pause,',
    '  Narration,',
    '  Callout,',
    '  ClickMarker,',
    `} from '${runtimeImportPath}'`,
    '',
    `export const semanticVideoPlan = ${JSON.stringify(semanticPlan, null, 2)} as const`,
    '',
    'export default function GeneratedSemanticVideoScript() {',
    '  return (',
    `    <VideoScript id={semanticVideoPlan.id} sourceVideo={__stagedAsset(semanticVideoPlan.source.videoPath)}${debugOverlay ? ' debug' : ''}${introPropsSegment}>`,
  ]

  for (const chapter of semanticPlan.chapters || []) {
    lines.push(`      <Chapter id=${renderJsxText(chapter.id)} title=${renderJsxText(chapter.title)}>`)
    for (const step of chapter.steps || []) {
      lines.push(`        <Step id=${renderJsxText(step.id)} title=${renderJsxText(step.title)}>`)
      lines.push(`          <Clip sourceStartMs={${Math.max(0, Number(step?.clip?.sourceStartMs || 0))}} sourceEndMs={${Math.max(1, Number(step?.clip?.sourceEndMs || 1))}} />`)
      for (const freeze of step.freezes || []) {
        lines.push(`          <Freeze atSourceMs={${Math.max(0, Number(freeze?.atSourceMs || 0))}} durationMs={${Math.max(1, Number(freeze?.durationMs || 1))}} />`)
      }
      for (const pause of step.pauses || []) {
        lines.push(`          <Pause atSourceMs={${Math.max(0, Number(pause?.atSourceMs || 0))}} durationMs={${Math.max(1, Number(pause?.durationMs || 1))}} />`)
      }
      for (const narration of step.narrations || []) {
        if (!narration.file) continue
        lines.push(`          <Narration id=${renderJsxText(narration.id)} file={__stagedAsset(${renderJsxText(narration.file)})} atMs={${Math.max(0, Number(narration?.atMs || 0))}} />`)
      }
      for (const callout of step.callouts || []) {
        const extraProps = [
          `text=${renderJsxText(callout.text)}`,
          `atMs={${Math.max(0, Number(callout?.atMs || 0))}}`,
          `durationMs={${Math.max(1, Number(callout?.durationMs || 1))}}`,
        ]
        if (callout.variant) extraProps.push(`variant=${renderJsxText(callout.variant)}`)
        if (Number.isFinite(Number(callout.fontSize))) extraProps.push(`fontSize={${Math.floor(Number(callout.fontSize))}}`)
        if (Number.isFinite(Number(callout.textYStart))) extraProps.push(`textYStart={${Math.floor(Number(callout.textYStart))}}`)
        if (Number.isFinite(Number(callout.lineSpacing))) extraProps.push(`lineSpacing={${Math.floor(Number(callout.lineSpacing))}}`)
        if (callout.logoLeft) extraProps.push(`logoLeft={__stagedAsset(${renderJsxText(callout.logoLeft)})}`)
        if (callout.logoRight) extraProps.push(`logoRight={__stagedAsset(${renderJsxText(callout.logoRight)})}`)
        lines.push(`          <Callout ${extraProps.join(' ')} />`)
      }
      for (const marker of step.clickMarkers || []) {
        lines.push(`          <ClickMarker atSourceMs={${Math.max(0, Number(marker?.atSourceMs || 0))}} x={${Math.max(0, Number(marker?.x || 0))}} y={${Math.max(0, Number(marker?.y || 0))}} durationMs={${Math.max(1, Number(marker?.durationMs || 1))}} />`)
      }
      lines.push('        </Step>')
    }
    lines.push('      </Chapter>')
  }

  lines.push('    </VideoScript>')
  lines.push('  )')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

export function buildRemotionRenderPlan({ semanticPlan, outputVideo, adjustedAudioFiles }) {
  const chapterSteps = (semanticPlan?.chapters || []).flatMap((chapter) => chapter.steps || [])
  let maxEndMs = 0
  for (const step of chapterSteps) {
    const clipDurationMs = Math.max(1, Number(step?.clip?.sourceEndMs || 0) - Number(step?.clip?.sourceStartMs || 0))
    const pauseDurationMs = (step?.pauses || []).reduce((sum, pause) => sum + Math.max(0, Number(pause?.durationMs || 0)), 0)
    const stepDurationMs = clipDurationMs + pauseDurationMs
    maxEndMs += stepDurationMs
  }

  const allNarrations = Array.isArray(adjustedAudioFiles) ? adjustedAudioFiles : []
  const narrationEndMs = allNarrations.reduce((maxValue, entry) => {
    return Math.max(maxValue, Math.max(0, Number(entry?.finalOutputEndMs || entry?.startMs || 0)))
  }, 0)
  const introDurationMs = Math.max(0, Math.floor(Number(semanticPlan?.source?.introDurationMs || 0)))
  const outputDurationMs = Math.max(maxEndMs + introDurationMs, narrationEndMs + introDurationMs, 1)
  const fps = Math.max(1, Number(semanticPlan?.source?.fps || 30))

  return {
    inputVideo: resolve(String(semanticPlan?.source?.videoPath || '')),
    outputVideo: resolve(String(outputVideo || '')),
    width: Number(semanticPlan?.source?.width || 1280),
    height: Number(semanticPlan?.source?.height || 720),
    fps,
    outputDurationSec: outputDurationMs / 1000,
    durationInFrames: Math.max(1, Math.ceil((outputDurationMs / 1000) * fps)),
    narrations: allNarrations
      .filter((entry) => Boolean(String(entry?.file || '').trim()))
      .map((entry) => ({
        id: String(entry?.id || ''),
        file: resolve(String(entry?.file || '')),
        startMs: Math.max(0, Math.floor(Number(entry?.finalOutputStartMs != null ? entry.finalOutputStartMs : entry?.startMs || 0))),
      })),
  }
}

function normalizeImportSpecifier(value) {
  const normalized = toPosixPath(value)
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}
