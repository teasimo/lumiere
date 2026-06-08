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
    narrationsByStepId.get(stepId).push({
      id: String(entry?.id || stepId),
      file: resolve(String(entry?.file || '')),
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

function toChapterCardCallout(chapterCard) {
  if (!chapterCard || typeof chapterCard !== 'object') {
    return []
  }

  return [{
    text: String(chapterCard.title || chapterCard.text || '').trim(),
    atMs: 0,
    durationMs: Math.max(1, Math.floor(Number(chapterCard.durationMs || 1))),
    variant: 'chapter-card',
    fontSize: Number(chapterCard.fontSize) || 54,
    textYStart: Number.isFinite(Number(chapterCard.textYStart)) ? Math.floor(Number(chapterCard.textYStart)) : null,
    lineSpacing: Number.isFinite(Number(chapterCard.lineSpacing)) ? Math.floor(Number(chapterCard.lineSpacing)) : null,
  }].filter((entry) => entry.text)
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
      const slideDurationMs = Math.max(1, Math.floor(Number(inlineSlide.durationMs || 3000)))
      timeline.push({
        type: 'slide',
        chapterId: currentChapterId,
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
          tags: [],
          clip: {
            sourceStartMs: Math.max(0, Number(chapterWindow?.sourceStartMs || 0)),
            sourceEndMs: Math.max(1, Number(chapterWindow?.sourceStartMs || 0) + 1000),
          },
          freezes: [],
          pauses: chapterPauses,
          narrations: chapterNarrations,
          callouts: toChapterCardCallout(chapterCard),
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

    currentChapter.steps.push({
      id: stepId,
      title: humanizeStepTitle(flowEntry?.step?.title || stepId) || stepId,
      tags: tagMap.get(stepId) || [],
      clip: {
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
      },
      freezes: [],
      pauses: basePauses,
      narrations: narrationsByStepId.get(stepId) || [],
      callouts: [],
      clickMarkers: baseMarkers,
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

function sourceToPlanOffsetMsForDocument(sourceMs, sourceStartMs, holds) {
  const clampedSourceMs = Math.max(sourceStartMs, Number(sourceMs || sourceStartMs))
  let offsetMs = Math.max(0, clampedSourceMs - sourceStartMs)
  for (const hold of holds) {
    if (Number(hold?.atSourceMs || 0) <= clampedSourceMs) {
      offsetMs += Math.max(0, Number(hold?.durationMs || 0))
    }
  }
  return offsetMs
}

function msToFrameStartForDocument(ms, fps) {
  return Math.max(0, Math.floor((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToFrameEndExclusiveForDocument(ms, fps) {
  return Math.max(1, Math.ceil((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToFrameIndexForDocument(ms, fps) {
  return Math.max(0, Math.round((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToDurationFramesForDocument(ms, fps) {
  return Math.max(1, Math.round((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToDurationFramesCeilForDocument(ms, fps) {
  return Math.max(1, Math.ceil((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

export function buildSemanticRemotionTsx({ semanticPlan, outputFilePath, runtimeFilePath }) {
  const runtimeImportPath = normalizeImportSpecifier(relative(dirname(outputFilePath), runtimeFilePath))
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
    `    <VideoScript id={semanticVideoPlan.id} sourceVideo={__stagedAsset(semanticVideoPlan.source.videoPath)} debug>`,
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

export function buildConcreteSequenceRemotionTsx({ semanticPlan }) {
  const fps = Math.max(1, Number(semanticPlan?.source?.fps || 30))
  const lines = [
    "import React from 'react'",
    "import { AbsoluteFill, Audio, Freeze as RemotionFreeze, OffthreadVideo, Sequence } from 'remotion'",
    '',
    `export const semanticVideoPlan = ${JSON.stringify(semanticPlan, null, 2)} as const`,
    `const SOURCE_VIDEO = ${renderJsxText(semanticPlan?.source?.videoPath || '')}`,
    '',
    'export default function GeneratedConcreteSequenceDocument() {',
    '  return (',
    '    <AbsoluteFill>',
  ]

  let stepStartMs = 0
  for (const chapter of semanticPlan?.chapters || []) {
    for (const step of chapter?.steps || []) {
      const stepId = String(step?.id || '')
      const stepTitle = String(step?.title || stepId)
      const sourceStartMs = Math.max(0, Number(step?.clip?.sourceStartMs || 0))
      const sourceEndMs = Math.max(sourceStartMs + 1, Number(step?.clip?.sourceEndMs || (sourceStartMs + 1)))
      const holds = [
        ...(Array.isArray(step?.freezes) ? step.freezes : []),
        ...(Array.isArray(step?.pauses) ? step.pauses : []),
      ]
        .map((hold) => ({
          atSourceMs: Math.max(0, Math.floor(Number(hold?.atSourceMs || 0))),
          durationMs: Math.max(1, Math.floor(Number(hold?.durationMs || 0))),
        }))
        .sort((left, right) => left.atSourceMs - right.atSourceMs)

      const sourceSegments = []
      const holdSegments = []
      let sourceCursorMs = sourceStartMs
      let planCursorMs = 0

      for (const hold of holds) {
        const atSourceMs = Math.min(sourceEndMs, Math.max(sourceStartMs, hold.atSourceMs))
        if (atSourceMs > sourceCursorMs) {
          sourceSegments.push({
            startMs: sourceCursorMs,
            endMs: atSourceMs,
            planStartMs: planCursorMs,
          })
          planCursorMs += atSourceMs - sourceCursorMs
          sourceCursorMs = atSourceMs
        }

        holdSegments.push({
          holdSourceMs: atSourceMs,
          durationMs: hold.durationMs,
          planStartMs: planCursorMs,
        })
        planCursorMs += hold.durationMs
      }

      if (sourceCursorMs < sourceEndMs) {
        sourceSegments.push({
          startMs: sourceCursorMs,
          endMs: sourceEndMs,
          planStartMs: planCursorMs,
        })
      }

      const stepDurationMs = Math.max(1, (sourceEndMs - sourceStartMs) + holds.reduce((sum, hold) => sum + hold.durationMs, 0))
      lines.push(`      {/* ${chapter.id} :: ${stepId} :: ${stepTitle} */}`)

      sourceSegments.forEach((segment, index) => {
        const globalStartMs = stepStartMs + segment.planStartMs
        const from = msToFrameStartForDocument(globalStartMs, fps)
        const startFromFrame = msToFrameStartForDocument(segment.startMs, fps)
        const endAtFrame = Math.max(startFromFrame + 1, msToFrameEndExclusiveForDocument(segment.endMs, fps))
        const durationInFrames = Math.max(1, endAtFrame - startFromFrame)
        lines.push(`      <Sequence key=${renderJsxText(`${chapter.id}:${stepId}:video:${index}`)} from={${from}} durationInFrames={${durationInFrames}}>`)
        lines.push(`        <OffthreadVideo src={SOURCE_VIDEO} startFrom={${startFromFrame}} endAt={${Math.max(startFromFrame + 1, endAtFrame)}} muted />`)
        lines.push('      </Sequence>')
      })

      holdSegments.forEach((hold, index) => {
        const globalStartMs = stepStartMs + hold.planStartMs
        const from = msToFrameStartForDocument(globalStartMs, fps)
        const durationInFrames = msToDurationFramesCeilForDocument(hold.durationMs, fps)
        const holdFrame = msToFrameStartForDocument(hold.holdSourceMs, fps)
        lines.push(`      <Sequence key=${renderJsxText(`${chapter.id}:${stepId}:hold:${index}`)} from={${from}} durationInFrames={${durationInFrames}}>`)
        lines.push(`        <RemotionFreeze frame={${holdFrame}}>`)
        lines.push('          <OffthreadVideo src={SOURCE_VIDEO} muted />')
        lines.push('        </RemotionFreeze>')
        lines.push('      </Sequence>')
      })

      for (const narration of step?.narrations || []) {
        const globalStartMs = stepStartMs + Math.max(0, Number(narration?.atMs || 0))
        const from = msToFrameIndexForDocument(globalStartMs, fps)
        lines.push(`      <Sequence key=${renderJsxText(`${chapter.id}:${stepId}:narration:${String(narration?.id || from)}`)} from={${from}}>`)
        lines.push(`        <Audio src={${renderJsxText(String(narration?.file || ''))}} />`)
        lines.push('      </Sequence>')
      }

      ;(step?.callouts || []).forEach((callout, index) => {
        const globalStartMs = stepStartMs + Math.max(0, Number(callout?.atMs || 0))
        const from = msToFrameIndexForDocument(globalStartMs, fps)
        const durationInFrames = msToDurationFramesForDocument(Math.max(1, Number(callout?.durationMs || 1200)), fps)
        const isChapterCard = callout?.variant === 'chapter-card'
        const lineSpacing = Number.isFinite(Number(callout?.lineSpacing)) ? Number(callout.lineSpacing) : 12
        const textYStart = Number.isFinite(Number(callout?.textYStart)) ? Number(callout.textYStart) : null
        lines.push(`      <Sequence key=${renderJsxText(`${chapter.id}:${stepId}:callout:${index}`)} from={${from}} durationInFrames={${durationInFrames}}>`)
        lines.push('        <AbsoluteFill')
        lines.push(`          style={${JSON.stringify(isChapterCard
          ? {
            justifyContent: 'flex-start',
            alignItems: 'stretch',
            paddingTop: textYStart ?? 160,
            paddingLeft: 32,
            paddingRight: 32,
            backgroundColor: 'rgba(255,255,255,0.28)',
            pointerEvents: 'none',
          }
          : {
            justifyContent: 'flex-end',
            alignItems: 'flex-end',
            padding: 24,
            pointerEvents: 'none',
          })}}`
        )
        lines.push('        >')
        lines.push('          <div')
        lines.push(`            style={${JSON.stringify(isChapterCard
            ? {
              color: 'white',
              fontWeight: 700,
              fontSize: Number(callout?.fontSize || 54),
              lineHeight: 1.2,
              textAlign: 'center',
              textShadow: '0 4px 18px rgba(0,0,0,0.45)',
              whiteSpace: 'pre-wrap',
            }
            : {
              backgroundColor: 'rgba(0,0,0,0.7)',
              color: 'white',
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 24,
            })}}`
        )
        lines.push('          >')
        if (isChapterCard) {
          for (const [lineIndex, line] of String(callout?.text || '').split('\n').entries()) {
            const isLast = lineIndex === String(callout?.text || '').split('\n').length - 1
            lines.push(`            <div key={${lineIndex}} style={{ marginBottom: ${isLast ? 0 : lineSpacing} }}>`)
            lines.push(`              {${renderJsxText(line)}}`)
            lines.push('            </div>')
          }
        } else {
          lines.push(`            {${renderJsxText(callout?.text || '')}}`)
        }
        lines.push('          </div>')
        lines.push('        </AbsoluteFill>')
        lines.push('      </Sequence>')
      })

      ;(step?.clickMarkers || []).forEach((marker, index) => {
        const markerPlanMs = sourceToPlanOffsetMsForDocument(marker?.atSourceMs, sourceStartMs, holds)
        const globalStartMs = stepStartMs + markerPlanMs
        const from = msToFrameIndexForDocument(globalStartMs, fps)
        const durationInFrames = msToDurationFramesForDocument(Math.max(1, Number(marker?.durationMs || 900)), fps)
        lines.push(`      <Sequence key=${renderJsxText(`${chapter.id}:${stepId}:click:${index}`)} from={${from}} durationInFrames={${durationInFrames}}>`)
        lines.push('        <AbsoluteFill style={{ pointerEvents: "none" }}>')
        lines.push('          <div')
        lines.push(`            style={${JSON.stringify({
          position: 'absolute',
          left: Math.max(0, Number(marker?.x || 0)) - 20,
          top: Math.max(0, Number(marker?.y || 0)) - 20,
          width: 40,
          height: 40,
          borderRadius: 999,
          border: '4px solid rgba(40, 52, 221, 0.95)',
          boxShadow: '0 0 0 8px rgba(153, 158, 230, 0.95)',
        })}}`
        )
        lines.push('          />')
        lines.push('        </AbsoluteFill>')
        lines.push('      </Sequence>')
      })

      lines.push(`      <Sequence key=${renderJsxText(`${chapter.id}:${stepId}:debug`)} from={${msToFrameStartForDocument(stepStartMs, fps)}} durationInFrames={${Math.max(1, msToFrameEndExclusiveForDocument(stepStartMs + stepDurationMs, fps) - msToFrameStartForDocument(stepStartMs, fps))}}>`)
      lines.push('        <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start", padding: 12, pointerEvents: "none" }}>')
      lines.push('          <div style={{ backgroundColor: "rgba(0,0,0,0.7)", color: "white", padding: "6px 10px", borderRadius: 6, fontSize: 18 }}>')
      lines.push(`            {${renderJsxText(`${chapter.title} :: ${stepTitle}`)}}`)
      lines.push('          </div>')
      lines.push('        </AbsoluteFill>')
      lines.push('      </Sequence>')

      stepStartMs += stepDurationMs
      lines.push('')
    }
  }

  lines.push('    </AbsoluteFill>')
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
  const outputDurationMs = Math.max(maxEndMs, narrationEndMs, 1)
  const fps = Math.max(1, Number(semanticPlan?.source?.fps || 30))

  return {
    inputVideo: resolve(String(semanticPlan?.source?.videoPath || '')),
    outputVideo: resolve(String(outputVideo || '')),
    width: Number(semanticPlan?.source?.width || 1280),
    height: Number(semanticPlan?.source?.height || 720),
    fps,
    outputDurationSec: outputDurationMs / 1000,
    durationInFrames: Math.max(1, Math.ceil((outputDurationMs / 1000) * fps)),
    narrations: allNarrations.map((entry) => ({
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
