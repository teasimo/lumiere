import {
  mkdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

function sanitizePathSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function captureTimelineStepScreenshot({
  page,
  testInfo,
  stepId,
  stepIndex,
}) {
  if (!page || !testInfo || typeof testInfo.outputPath !== 'function') {
    return null
  }

  const stepToken = sanitizePathSegment(stepId) || `step-${stepIndex + 1}`
  const screenshotFilename = `${String(stepIndex + 1).padStart(3, '0')}-${stepToken}.png`
  const screenshotRelativePath = join('timeline-screenshots', screenshotFilename)
  const screenshotAbsolutePath = testInfo.outputPath(screenshotRelativePath)

  await mkdir(dirname(screenshotAbsolutePath), { recursive: true })
  await page.screenshot({
    path: screenshotAbsolutePath,
    type: 'png',
    fullPage: true,
  })

  return screenshotRelativePath.replace(/\\/g, '/')
}

function buildTimelineStepSegment(step) {
  const interactionType = inferTimelineInteractionType(step)
  const startedAtMs = Number(step?.startedAtMs)
  const endedAtMs = Number(step?.endedAtMs)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null
  }
  const normalizedEndMs = endedAtMs <= startedAtMs
    ? startedAtMs + 1
    : endedAtMs

  return {
    stepId: String(step?.stepId || '').trim() || null,
    label: String(step?.stepDescription || step?.stepId || '').trim() || '<step>',
    interactionType,
    startMs: Math.max(0, Math.round(startedAtMs)),
    endMs: Math.max(1, Math.round(normalizedEndMs)),
  }
}

function buildTimelineClickMarker(step) {
  const interactionType = inferTimelineInteractionType(step)
  const point = step?.clickPoint
  const x = Number(point?.x)
  const y = Number(point?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  const clickedAtMs = Number(step?.clickedAtMs)
  const startedAtMs = Number(step?.startedAtMs)
  const endedAtMs = Number(step?.endedAtMs)
  const fallbackAtMs = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
    ? startedAtMs + Math.max(0, Math.round((endedAtMs - startedAtMs) / 2))
    : Number.isFinite(startedAtMs)
      ? startedAtMs
      : endedAtMs

  const atMs = Number.isFinite(clickedAtMs)
    ? clickedAtMs
    : fallbackAtMs

  if (!Number.isFinite(atMs)) {
    return null
  }

  return {
    stepId: String(step?.stepId || '').trim() || null,
    interactionType,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    atMs: Math.max(0, Math.round(atMs)),
  }
}

function inferTimelineInteractionType(step) {
  const explicitType = String(step?.interactionType || '').trim().toLowerCase()
  if (explicitType) {
    return explicitType
  }
  if (step?.clickPoint || step?.clickedElement) {
    return 'click'
  }
  if (step?.fillPoint) {
    return 'fill'
  }
  if (step?.scrollDirection) {
    return 'scroll'
  }
  return null
}

function buildTimelineVideoSection(timeline, viewport = null) {
  const stepSegments = []
  const clickMarkers = []

  for (const step of Array.isArray(timeline) ? timeline : []) {
    const segment = buildTimelineStepSegment(step)
    if (segment) {
      stepSegments.push(segment)
    }

    if (inferTimelineInteractionType(step) === 'click') {
      const clickMarker = buildTimelineClickMarker(step)
      if (clickMarker) {
        clickMarkers.push(clickMarker)
      }
    }
  }

  return {
    viewport: viewport && Number.isFinite(Number(viewport?.width)) && Number.isFinite(Number(viewport?.height))
      ? {
          width: Math.max(1, Math.round(Number(viewport.width))),
          height: Math.max(1, Math.round(Number(viewport.height))),
        }
      : null,
    stepSegments,
    clickMarkers,
  }
}

export function createScenarioExecutionRuntime({
  wrapStep = null,
  onStepComplete = null,
  page,
  waitBetweenStepsMs = 0,
  stepTimeoutMs = 30000,
}) {
  function createStepLogEntry(level, message, data = null) {
    return {
      timestamp: new Date().toISOString(),
      level: String(level || 'info'),
      message: String(message || ''),
      data: data == null ? null : data,
    }
  }

  const effectiveWrapStep = typeof wrapStep === 'function'
    ? wrapStep
    : async (_stepId, execute) => execute()

  return {
    async runStep(stepId, stepDescription, execute, stepMeta = {}) {
      const startedAtMs = Date.now()
      const startedAtIso = new Date(startedAtMs).toISOString()
      const stepLog = []
      const selectors = Array.isArray(stepMeta?.selectors)
        ? stepMeta.selectors.map((entry) => String(entry || '').trim()).filter(Boolean)
        : []
      const interactionType = stepMeta?.interactionType == null
        ? null
        : String(stepMeta.interactionType)
      const stepDetails = {}
      const appendStepLog = (level, message, data = null) => {
        stepLog.push(createStepLogEntry(level, message, data))
      }
      const stepRuntime = {
        log(level, message, data = null) {
          appendStepLog(level, message, data)
        },
        info(message, data = null) {
          appendStepLog('info', message, data)
        },
        warn(message, data = null) {
          appendStepLog('warning', message, data)
        },
        error(message, data = null) {
          appendStepLog('error', message, data)
        },
        setStepDetail(key, value) {
          const normalizedKey = String(key || '').trim()
          if (!normalizedKey) {
            return
          }
          stepDetails[normalizedKey] = value
        },
        mergeStepDetails(values) {
          if (!values || typeof values !== 'object') {
            return
          }
          Object.assign(stepDetails, values)
        },
      }

      let executeResult = null
      let thrownError = null
      let timeoutLogged = false
      let skipped = false
      let noop = false
      let status = 'executed'
      let skipReason = null
      let errorInfo = null

      try {
        executeResult = await effectiveWrapStep(stepId, async () => {
          const effectiveStepTimeoutMs = Math.max(0, Number(stepTimeoutMs) || 0)
          if (effectiveStepTimeoutMs <= 0) {
            return execute(stepRuntime)
          }

          let timeoutHandle = null
          try {
            return await Promise.race([
              execute(stepRuntime),
              new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  timeoutLogged = true
                  appendStepLog('error', 'step-timeout', {
                    stepId: stepId || null,
                    stepDescription: stepDescription || null,
                    timeoutMs: effectiveStepTimeoutMs,
                    currentUrl: page?.url?.() || null,
                  })
                  const timeoutError = new Error(`Scenario step timed out after ${effectiveStepTimeoutMs}ms: ${stepId || '<no-id>'} | ${stepDescription || '<no-description>'}`)
                  timeoutError.name = 'ScenarioStepTimeoutError'
                  timeoutError.code = 'SCENARIO_STEP_TIMEOUT'
                  timeoutError.stepTimeoutMs = effectiveStepTimeoutMs
                  reject(timeoutError)
                }, effectiveStepTimeoutMs)
              }),
            ])
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle)
            }
          }
        })

        skipped = Boolean(
          executeResult &&
          typeof executeResult === 'object' &&
          executeResult.__scenarioStepStatus === 'skipped'
        )
        noop = Boolean(
          executeResult &&
          typeof executeResult === 'object' &&
          executeResult.__scenarioStepStatus === 'noop'
        )
        status = skipped ? 'skipped' : 'executed'
        skipReason = skipped
          ? String(executeResult.reason || 'step guard condition was not met')
          : null
      } catch (error) {
        thrownError = error
        const isTimeout = error?.code === 'SCENARIO_STEP_TIMEOUT' || error?.name === 'ScenarioStepTimeoutError'
        status = isTimeout ? 'timeout' : 'failed'
        errorInfo = {
          name: String(error?.name || 'Error'),
          code: error?.code == null ? null : String(error.code),
          message: String(error?.message || error),
        }
        if (!timeoutLogged) {
          appendStepLog(isTimeout ? 'error' : 'warning', isTimeout ? 'step-timeout' : 'step-failed', {
            stepId: stepId || null,
            stepDescription: stepDescription || null,
            currentUrl: page?.url?.() || null,
            ...errorInfo,
            timeoutMs: Number.isFinite(Number(error?.stepTimeoutMs)) ? Number(error.stepTimeoutMs) : null,
          })
        }
      }

      const endedAtMs = Date.now()
      const endedAtIso = new Date(endedAtMs).toISOString()

      const statusText = skipped
        ? `SKIPPED (${skipReason})`
        : status === 'timeout'
          ? `TIMEOUT (${errorInfo?.message || 'step timeout'})`
          : status === 'failed'
            ? `FAILED (${errorInfo?.message || 'step failed'})`
            : 'EXECUTED'
      console.log(`[scenario-step] ${stepId} | ${stepDescription} | ${statusText} | ${startedAtIso} -> ${endedAtIso} (${endedAtMs - startedAtMs}ms)`)

      const shouldWaitAfterStep = !skipped && !noop
      if (!thrownError && waitBetweenStepsMs > 0 && shouldWaitAfterStep && page) {
        await page.waitForTimeout(waitBetweenStepsMs)
      }

      const stepReport = {
        stepId,
        stepDescription,
        selectors,
        interactionType,
        status,
        skipped,
        skipReason,
        startedAtMs,
        endedAtMs,
        startedAtIso,
        endedAtIso,
        durationMs: endedAtMs - startedAtMs,
        error: errorInfo,
        log: stepLog,
        ...stepDetails,
      }

      if (typeof onStepComplete === 'function') {
        await onStepComplete(stepReport)
      }

      if (thrownError) {
        throw thrownError
      }

      return executeResult
    },
  }
}

export function createScenarioTimelineRuntime({
  test,
  testInfo,
  scenarioId,
  scenarioVersion,
  scenarioSource,
  page,
  videoModeEnabled = false,
  waitBetweenStepsMs = 0,
  stepTimeoutMs = 30000,
}) {
  const timeline = []
  let stepIndex = 0
  const runtime = createScenarioExecutionRuntime({
    wrapStep: (stepId, execute) => test.step(stepId, execute),
    onStepComplete: async (stepReport) => {
      let screenshotPath = null
      try {
        screenshotPath = await captureTimelineStepScreenshot({
          page,
          testInfo,
          stepId: stepReport?.stepId,
          stepIndex,
        })
      } catch (error) {
        const screenshotError = {
          name: String(error?.name || 'Error'),
          message: String(error?.message || error),
        }
        const nextLog = Array.isArray(stepReport?.log) ? [...stepReport.log] : []
        nextLog.push({
          timestamp: new Date().toISOString(),
          level: 'warning',
          message: 'timeline-screenshot-failed',
          data: screenshotError,
        })
        stepReport = {
          ...stepReport,
          log: nextLog,
        }
      }

      timeline.push({
        ...stepReport,
        screenshotPath,
      })
      stepIndex += 1
    },
    page,
    waitBetweenStepsMs: videoModeEnabled ? waitBetweenStepsMs : 0,
    stepTimeoutMs,
  })

  return {
    runStep: runtime.runStep,

    async flush() {
      const viewport = typeof page?.viewportSize === 'function'
        ? page.viewportSize()
        : null
      const timelineReport = {
        scenarioId,
        scenarioVersion,
        scenarioSource,
        generatedAtIso: new Date().toISOString(),
        steps: timeline,
        video: buildTimelineVideoSection(timeline, viewport),
      }

      const timelinePath = testInfo.outputPath('scenario-step-timeline.json')
      await writeFile(timelinePath, JSON.stringify(timelineReport, null, 2), 'utf8')
      console.log(`[scenario-step] timeline report: ${timelinePath}`)
    },
  }
}
