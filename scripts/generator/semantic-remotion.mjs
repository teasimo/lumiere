import { dirname, relative, resolve } from 'path'

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

    const stepId = String(step.id || '').trim()
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

    const fullId = idPrefix ? `${idPrefix}-${stepId}` : stepId
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
  const clipStartMs = presentationRange ? Math.max(0, Number(presentationRange.startMs) || 0) : 0
  const clipEndMs = presentationRange?.endMs == null ? null : Math.max(0, Number(presentationRange.endMs) || 0)
  const stepWindowById = new Map()

  for (const flowEntry of flattenedFlowStepEntries) {
    let window = resolvePresentationStepWindowMs(flowEntry.id, sortedTimelineSteps)
    if (!window && flowEntry.isSyntheticId) {
      window = resolveNeighborWindowForAnonStep(flowEntry.id, flattenedFlowStepEntries, sortedTimelineSteps)
    }
    if (!window) {
      continue
    }

    const clipRelativeStartMs = Math.max(0, Math.floor(window.startedAtMs - clipStartMs))
    const unclampedEndMs = Math.max(window.startedAtMs, window.endedAtMs)
    const absoluteEndMs = clipEndMs == null ? unclampedEndMs : Math.min(unclampedEndMs, clipEndMs)
    const clipRelativeEndMs = Math.max(clipRelativeStartMs + 1, Math.floor(absoluteEndMs - clipStartMs))

    stepWindowById.set(flowEntry.id, {
      sourceStartMs: clipRelativeStartMs,
      sourceEndMs: clipRelativeEndMs,
      originalStartMs: Math.max(0, Math.floor(window.startedAtMs)),
      originalEndMs: Math.max(0, Math.floor(absoluteEndMs)),
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

function groupClickMarkersByStep(stepWindowById, clickMarkers) {
  const clickMarkersByStepId = new Map()
  for (const [stepId, window] of stepWindowById.entries()) {
    const markers = (Array.isArray(clickMarkers) ? clickMarkers : [])
      .filter((marker) => {
        const markerAtMs = Math.max(0, Math.round(Number(marker?.at || 0) * 1000))
        return markerAtMs >= window.sourceStartMs && markerAtMs <= window.sourceEndMs
      })
      .map((marker) => ({
        atSourceMs: Math.max(0, Math.round(Number(marker?.at || 0) * 1000)),
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

export function buildSemanticVideoPlan({
  scenarioRoot,
  timelineReport,
  presentationRange = null,
  chapterCards = [],
  clickMarkers = [],
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
  const clickMarkersByStepId = groupClickMarkersByStep(stepWindowById, clickMarkers)
  const tagMap = buildStepTagMap(stepWindowById, stepSegments)
  const chapterCardById = new Map((Array.isArray(chapterCards) ? chapterCards : []).map((entry) => [String(entry?.sourceScenarioStepId || '').trim(), entry]))

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
    currentChapter.steps.push({
      id: stepId,
      title: humanizeStepTitle(flowEntry?.step?.title || stepId) || stepId,
      tags: tagMap.get(stepId) || [],
      clip: {
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
      },
      freezes: [],
      pauses: pausesByStepId.get(stepId) || [],
      narrations: narrationsByStepId.get(stepId) || [],
      callouts: [],
      clickMarkers: clickMarkersByStepId.get(stepId) || [],
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
