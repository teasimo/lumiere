import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRemotionRenderPlan,
  buildSemanticVideoPlan,
} from './semantic-remotion.mjs'

test('buildSemanticVideoPlan maps timeline click markers onto their source step', () => {
  const plan = buildSemanticVideoPlan({
    scenarioRoot: {
      id: 'scenario-1',
      title: 'Scenario 1',
      flow: [
        { id: 'step-1', title: 'Step 1', interaction: { type: 'click' } },
        { id: 'step-2', title: 'Step 2', interaction: { type: 'click' } },
      ],
    },
    timelineReport: {
      steps: [
        { stepId: 'step-1', startedAtMs: 1000, endedAtMs: 1500 },
        { stepId: 'step-2', startedAtMs: 1500, endedAtMs: 2000 },
      ],
    },
    presentationRange: {
      startMs: 0,
      endMs: 1000,
    },
    clickMarkers: [
      { stepId: 'step-2', at: 0.2, x: 320, y: 180, durationMs: 200 },
    ],
    clickIndicator: {
      beforeMs: 100,
      highlightDurationMs: 300,
      afterMs: 100,
      fadeMs: 50,
    },
    adjustedAudioFiles: [],
    inputVideo: '/tmp/input.mp4',
    outputVideo: '/tmp/output.mp4',
    width: 1280,
    height: 720,
    fps: 30,
  })

  const steps = plan.chapters.flatMap((chapter) => chapter.steps)
  const firstMainStep = steps.find((step) => step.id === 'step-1')
  const secondMainStep = steps.find((step) => step.id === 'step-2')

  assert.ok(firstMainStep)
  assert.ok(secondMainStep)
  assert.equal(firstMainStep.clickMarkers.length, 0)
  assert.equal(secondMainStep.clickMarkers.length, 1)
  assert.equal(secondMainStep.clickMarkers[0].atSourceMs, 500)
  assert.equal(secondMainStep.clickMarkers[0].x, 320)
  assert.equal(secondMainStep.clickMarkers[0].y, 180)
})

test('buildRemotionRenderPlan duration follows semantic step durations instead of raw narration source offsets', () => {
  const renderPlan = buildRemotionRenderPlan({
    semanticPlan: {
      source: {
        videoPath: '/tmp/input.mp4',
        fps: 30,
        width: 1280,
        height: 720,
        introDurationMs: 0,
      },
      chapters: [
        {
          id: 'chapter-1',
          title: 'Chapter 1',
          steps: [
            {
              id: 'step-1',
              clip: { sourceStartMs: 0, sourceEndMs: 1000 },
              pauses: [],
            },
          ],
        },
      ],
    },
    outputVideo: '/tmp/output.mp4',
    adjustedAudioFiles: [
      {
        id: 'late-narration',
        startMs: 9000,
        finalOutputStartMs: 9000,
        finalOutputEndMs: 10000,
        file: '/tmp/audio.mp3',
      },
    ],
  })

  assert.equal(renderPlan.outputDurationSec, 1)
  assert.equal(renderPlan.durationInFrames, 30)
})

test('buildSemanticVideoPlan inserts scroll segments between included steps', () => {
  const plan = buildSemanticVideoPlan({
    scenarioRoot: {
      id: 'scenario-scroll',
      title: 'Scenario Scroll',
      flow: [
        { id: 'step-1', title: 'Step 1', interaction: { type: 'fill' } },
        { id: 'step-2', title: 'Step 2', interaction: { type: 'click' } },
      ],
    },
    timelineReport: {
      steps: [
        { stepId: 'step-1', startedAtMs: 1000, endedAtMs: 1500 },
        { stepId: 'step-2__autoscroll', interactionType: 'scroll', startedAtMs: 2000, endedAtMs: 2200 },
        { stepId: 'step-2', startedAtMs: 2500, endedAtMs: 3000 },
      ],
    },
    stepSegments: [
      { stepId: 'step-1', interactionType: 'fill', start: 0, end: 0.5 },
      { stepId: 'step-2__autoscroll', interactionType: 'scroll', start: 1, end: 1.2 },
      { stepId: 'step-2', interactionType: 'click', start: 1.5, end: 2 },
    ],
    adjustedAudioFiles: [],
    inputVideo: '/tmp/input.mp4',
    outputVideo: '/tmp/output.mp4',
    width: 1280,
    height: 720,
    fps: 30,
  })

  const steps = plan.chapters.flatMap((chapter) => chapter.steps)
  assert.deepEqual(steps.map((step) => step.id), [
    'step-1',
    'step-2__autoscroll',
    'step-2',
  ])
  assert.deepEqual(steps[1].clip, {
    sourceStartMs: 1000,
    sourceEndMs: 1200,
  })
})

test('buildSemanticVideoPlan bridges unchanged step overlays across scroll segments', () => {
  const plan = buildSemanticVideoPlan({
    scenarioRoot: {
      id: 'scenario-scroll-overlay',
      title: 'Scenario Scroll Overlay',
      flow: [
        { id: 'step-1', title: 'Same Section', interaction: { type: 'fill' } },
        { id: 'step-2', title: 'Same Section', interaction: { type: 'fill' } },
        { id: 'step-3', title: 'Different Section', interaction: { type: 'fill' } },
      ],
    },
    timelineReport: {
      steps: [
        { stepId: 'step-1', startedAtMs: 1000, endedAtMs: 1500 },
        { stepId: 'step-2__autoscroll', interactionType: 'scroll', startedAtMs: 1800, endedAtMs: 1900 },
        { stepId: 'step-2', startedAtMs: 2200, endedAtMs: 2700 },
        { stepId: 'step-3__autoscroll', interactionType: 'scroll', startedAtMs: 3000, endedAtMs: 3100 },
        { stepId: 'step-3', startedAtMs: 3400, endedAtMs: 3900 },
      ],
    },
    stepSegments: [
      { stepId: 'step-1', interactionType: 'fill', start: 0, end: 0.5 },
      { stepId: 'step-2__autoscroll', interactionType: 'scroll', start: 0.8, end: 0.9 },
      { stepId: 'step-2', interactionType: 'fill', start: 1.2, end: 1.7 },
      { stepId: 'step-3__autoscroll', interactionType: 'scroll', start: 2, end: 2.1 },
      { stepId: 'step-3', interactionType: 'fill', start: 2.4, end: 2.9 },
    ],
    adjustedAudioFiles: [],
    inputVideo: '/tmp/input.mp4',
    outputVideo: '/tmp/output.mp4',
    width: 1280,
    height: 720,
    fps: 30,
  })

  const steps = plan.chapters.flatMap((chapter) => chapter.steps)
  const bridgedScroll = steps.find((step) => step.id === 'step-2__autoscroll')
  const changedScroll = steps.find((step) => step.id === 'step-3__autoscroll')

  assert.equal(bridgedScroll.callouts.length, 1)
  assert.equal(bridgedScroll.callouts[0].variant, 'step-overlay')
  assert.equal(bridgedScroll.callouts[0].text, steps.find((step) => step.id === 'step-2').callouts[0].text)
  assert.equal(bridgedScroll.callouts[0].durationMs, 100)
  assert.equal(changedScroll.callouts.length, 0)
})
