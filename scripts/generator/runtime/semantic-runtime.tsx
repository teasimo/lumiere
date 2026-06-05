// @ts-nocheck
import React, { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { AbsoluteFill, Audio, Freeze as RemotionFreeze, OffthreadVideo, Sequence, useVideoConfig } from 'remotion'

type BaseProps = {
  children?: ReactNode
}

type VideoScriptProps = BaseProps & {
  id: string
  sourceVideo: string
  fps?: number
  width?: number
  height?: number
  debug?: boolean
}

type ChapterProps = BaseProps & {
  id: string
  title: string
}

type SectionProps = BaseProps & {
  id: string
  title?: string
}

type StepProps = BaseProps & {
  id: string
  title?: string
}

type ClipProps = {
  sourceStartMs: number
  sourceEndMs: number
}

type FreezeProps = {
  atSourceMs: number
  durationMs: number
}

type PauseProps = {
  atSourceMs: number
  durationMs: number
}

type NarrationProps = {
  id?: string
  file: string
  atMs?: number
}

type CalloutProps = {
  text: string
  atMs?: number
  durationMs?: number
  variant?: 'default' | 'chapter-card'
  fontSize?: number
  textYStart?: number | null
  lineSpacing?: number | null
}

type ClickMarkerProps = {
  atSourceMs: number
  x: number
  y: number
  durationMs?: number
}

type HoldEvent = {
  atSourceMs: number
  durationMs: number
}

type StepPlan = {
  chapterId: string
  chapterTitle: string
  stepId: string
  stepTitle: string
  clip: ClipProps
  holds: HoldEvent[]
  narrations: NarrationProps[]
  callouts: CalloutProps[]
  clickMarkers: ClickMarkerProps[]
  durationMs: number
}

export const VideoScript: React.FC<VideoScriptProps> = ({
  sourceVideo,
  children,
  debug = false,
}) => {
  const { fps: fpsFromComposition } = useVideoConfig()
  const fps = Math.max(1, Number(fpsFromComposition || 30))
  const chapters = collectChapters(children)
  const stepPlans = flattenStepPlans(chapters)

  let cursorMs = 0
  const planned = stepPlans.map((step) => {
    const startMs = cursorMs
    cursorMs += step.durationMs
    return {
      ...step,
      startMs,
    }
  })

  return (
    <AbsoluteFill>
      {planned.map((step) => {
        const from = msToFrameStart(step.startMs, fps)
        const to = Math.max(
          from + 1,
          msToFrameEndExclusive(step.startMs + step.durationMs, fps),
        )
        const durationInFrames = Math.max(1, to - from)
        return (
          <Sequence key={`${step.chapterId}:${step.stepId}`} from={from} durationInFrames={durationInFrames}>
            <StepRenderer sourceVideo={sourceVideo} fps={fps} step={step} debug={debug} />
          </Sequence>
        )
      })}
    </AbsoluteFill>
  )
}

export const Chapter: React.FC<ChapterProps> = () => null
export const Section: React.FC<SectionProps> = () => null
export const Step: React.FC<StepProps> = () => null
export const Clip: React.FC<ClipProps> = () => null
export const Freeze: React.FC<FreezeProps> = () => null
export const Pause: React.FC<PauseProps> = () => null
export const Narration: React.FC<NarrationProps> = () => null
export const Callout: React.FC<CalloutProps> = () => null
export const ClickMarker: React.FC<ClickMarkerProps> = () => null

type StepRendererProps = {
  sourceVideo: string
  fps: number
  step: StepPlan
  debug: boolean
}

const StepRenderer: React.FC<StepRendererProps> = ({ sourceVideo, fps, step, debug }) => {
  const sourceStartMs = Math.max(0, Number(step.clip.sourceStartMs || 0))
  const sourceEndMs = Math.max(sourceStartMs + 1, Number(step.clip.sourceEndMs || sourceStartMs + 1))
  const holds = [...step.holds].sort((a, b) => a.atSourceMs - b.atSourceMs)

  const sourceSegments: Array<{ startMs: number, endMs: number, planStartMs: number }> = []
  const holdSegments: Array<{ holdSourceMs: number, durationMs: number, planStartMs: number }> = []

  let sourceCursorMs = sourceStartMs
  let planCursorMs = 0

  for (const hold of holds) {
    const atSourceMs = clamp(hold.atSourceMs, sourceStartMs, sourceEndMs)
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

  return (
    <AbsoluteFill>
      {sourceSegments.map((segment, index) => {
        const from = msToFrameStart(segment.planStartMs, fps)
        const segmentDurationMs = segment.endMs - segment.startMs
        const startFromFrame = msToFrameStart(segment.startMs, fps)
        const endAtFrame = Math.max(startFromFrame + 1, msToFrameEndExclusive(segment.endMs, fps))
        const durationInFrames = Math.max(1, endAtFrame - startFromFrame)

        return (
          <Sequence key={`video-${index}`} from={from} durationInFrames={durationInFrames}>
            <OffthreadVideo src={sourceVideo} startFrom={startFromFrame} endAt={Math.max(startFromFrame + 1, endAtFrame)} muted />
          </Sequence>
        )
      })}

      {holdSegments.map((hold, index) => {
        const from = msToFrameStart(hold.planStartMs, fps)
        const durationInFrames = msToDurationFramesCeil(hold.durationMs, fps)
        const holdFrame = msToFrameStart(hold.holdSourceMs, fps)
        return (
          <Sequence key={`hold-${index}`} from={from} durationInFrames={durationInFrames}>
            <RemotionFreeze frame={holdFrame}>
              <OffthreadVideo src={sourceVideo} muted />
            </RemotionFreeze>
          </Sequence>
        )
      })}

      {step.narrations.map((narration, index) => {
        const from = msToFrameIndex(Math.max(0, Number(narration.atMs || 0)), fps)
        return (
          <Sequence key={narration.id || `narration-${index}`} from={from}>
            <Audio src={narration.file} />
          </Sequence>
        )
      })}

      {step.callouts.map((callout, index) => {
        const from = msToFrameIndex(Math.max(0, Number(callout.atMs || 0)), fps)
        const durationInFrames = msToDurationFrames(Math.max(1, Number(callout.durationMs || 1200)), fps)
        const isChapterCard = callout.variant === 'chapter-card'
        const lineSpacing = Number.isFinite(Number(callout.lineSpacing)) ? Number(callout.lineSpacing) : 12
        const textYStart = Number.isFinite(Number(callout.textYStart)) ? Number(callout.textYStart) : null
        return (
          <Sequence key={`callout-${index}`} from={from} durationInFrames={durationInFrames}>
            <AbsoluteFill
              style={isChapterCard
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
                }}
            >
              <div
                style={isChapterCard
                  ? {
                    color: 'white',
                    fontWeight: 700,
                    fontSize: Number(callout.fontSize || 54),
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
                  }}
              >
                {isChapterCard
                  ? String(callout.text || '').split('\n').map((line, lineIndex) => (
                    <div key={lineIndex} style={{ marginBottom: lineIndex === String(callout.text || '').split('\n').length - 1 ? 0 : lineSpacing }}>
                      {line}
                    </div>
                  ))
                  : callout.text}
              </div>
            </AbsoluteFill>
          </Sequence>
        )
      })}

      {step.clickMarkers.map((marker, index) => {
        const markerPlanMs = sourceToPlanOffsetMs(marker.atSourceMs, sourceStartMs, holds)
        const from = msToFrameIndex(markerPlanMs, fps)
        const durationInFrames = msToDurationFrames(Math.max(1, Number(marker.durationMs || 900)), fps)
        return (
          <Sequence key={`click-${index}`} from={from} durationInFrames={durationInFrames}>
            <AbsoluteFill style={{ pointerEvents: 'none' }}>
              <div
                style={{
                  position: 'absolute',
                  left: marker.x - 20,
                  top: marker.y - 20,
                  width: 40,
                  height: 40,
                  borderRadius: 999,
                  border: '4px solid rgba(40, 52, 221, 0.95)',
                  boxShadow: '0 0 0 8px rgba(153, 158, 230, 0.95)',
                }}
              />
            </AbsoluteFill>
          </Sequence>
        )
      })}

      {debug ? (
        <AbsoluteFill style={{ justifyContent: 'flex-start', alignItems: 'flex-start', padding: 12, pointerEvents: 'none' }}>
          <div style={{ backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', padding: '6px 10px', borderRadius: 6, fontSize: 18 }}>
            {step.chapterTitle} :: {step.stepTitle}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  )
}

function collectChapters(children: ReactNode) {
  const chapterElements = childrenToElements(children).filter((child) => child.type === Chapter)
  return chapterElements.map((chapterElement) => {
    const chapterProps = chapterElement.props as ChapterProps
    const steps = collectSteps(chapterElement.props.children)
    return {
      id: chapterProps.id,
      title: chapterProps.title,
      steps,
    }
  })
}

function collectSteps(children: ReactNode) {
  const entries: Array<{ step: ReactElement<StepProps>, chapterLikeTitle?: string }> = []

  for (const child of childrenToElements(children)) {
    if (child.type === Step) {
      entries.push({ step: child as ReactElement<StepProps> })
      continue
    }

    if (child.type === Section) {
      const sectionTitle = String((child.props as SectionProps).title || '').trim() || undefined
      const sectionSteps = childrenToElements(child.props.children).filter((nested) => nested.type === Step)
      for (const sectionStep of sectionSteps) {
        entries.push({ step: sectionStep as ReactElement<StepProps>, chapterLikeTitle: sectionTitle })
      }
    }
  }

  return entries
}

function flattenStepPlans(chapters: Array<{ id: string, title: string, steps: Array<{ step: ReactElement<StepProps>, chapterLikeTitle?: string }> }>): StepPlan[] {
  const plans: StepPlan[] = []

  for (const chapter of chapters) {
    for (const entry of chapter.steps) {
      const stepProps = entry.step.props as StepProps
      const parsed = parseStepChildren(stepProps.children)
      if (!parsed.clip) {
        continue
      }

      const clipDurationMs = Math.max(1, parsed.clip.sourceEndMs - parsed.clip.sourceStartMs)
      const holdDurationMs = parsed.holds.reduce((sum, hold) => sum + hold.durationMs, 0)
      const durationMs = clipDurationMs + holdDurationMs

      plans.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        stepId: stepProps.id,
        stepTitle: stepProps.title || entry.chapterLikeTitle || stepProps.id,
        clip: parsed.clip,
        holds: parsed.holds,
        narrations: parsed.narrations,
        callouts: parsed.callouts,
        clickMarkers: parsed.clickMarkers,
        durationMs,
      })
    }
  }

  return plans
}

function parseStepChildren(children: ReactNode) {
  let clip: ClipProps | null = null
  const holds: HoldEvent[] = []
  const narrations: NarrationProps[] = []
  const callouts: CalloutProps[] = []
  const clickMarkers: ClickMarkerProps[] = []

  for (const child of childrenToElements(children)) {
    if (child.type === Clip) {
      clip = child.props as ClipProps
      continue
    }
    if (child.type === Freeze || child.type === Pause) {
      const props = child.props as FreezeProps | PauseProps
      holds.push({
        atSourceMs: Math.max(0, Math.floor(Number(props.atSourceMs || 0))),
        durationMs: Math.max(1, Math.floor(Number(props.durationMs || 0))),
      })
      continue
    }
    if (child.type === Narration) {
      narrations.push(child.props as NarrationProps)
      continue
    }
    if (child.type === Callout) {
      callouts.push(child.props as CalloutProps)
      continue
    }
    if (child.type === ClickMarker) {
      clickMarkers.push(child.props as ClickMarkerProps)
    }
  }

  holds.sort((a, b) => a.atSourceMs - b.atSourceMs)

  return {
    clip,
    holds,
    narrations,
    callouts,
    clickMarkers,
  }
}

function childrenToElements(children: ReactNode): ReactElement[] {
  const list = Children.toArray(children)
  const elements: ReactElement[] = []
  for (const child of list) {
    if (!isValidElement(child)) continue
    elements.push(child)
  }
  return elements
}

function sourceToPlanOffsetMs(sourceMs: number, sourceStartMs: number, holds: HoldEvent[]): number {
  const clampedSourceMs = Math.max(sourceStartMs, Number(sourceMs || sourceStartMs))
  let offsetMs = Math.max(0, clampedSourceMs - sourceStartMs)
  for (const hold of holds) {
    if (hold.atSourceMs <= clampedSourceMs) {
      offsetMs += hold.durationMs
    }
  }
  return offsetMs
}

function msToFrameStart(ms: number, fps: number): number {
  return Math.max(0, Math.floor((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToFrameEndExclusive(ms: number, fps: number): number {
  return Math.max(1, Math.ceil((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToDurationFramesCeil(ms: number, fps: number): number {
  return Math.max(1, Math.ceil((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToFrameIndex(ms: number, fps: number): number {
  return Math.max(0, Math.round((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function msToDurationFrames(ms: number, fps: number): number {
  return Math.max(1, Math.round((Math.max(0, Number(ms || 0)) / 1000) * fps))
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value))
}

export const SemanticNoop: React.FC = () => <Fragment />
