import {
  writeFile
} from 'node:fs/promises'

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

  return {
    async runStep(stepId, stepDescription, execute) {
      const startedAtMs = Date.now()
      const startedAtIso = new Date(startedAtMs).toISOString()

      const executeResult = await test.step(stepId, async () => {
        const effectiveStepTimeoutMs = Math.max(0, Number(stepTimeoutMs) || 0)
        if (effectiveStepTimeoutMs <= 0) {
          return execute()
        }

        let timeoutHandle = null
        try {
          return await Promise.race([
            execute(),
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(new Error(`Scenario step timed out after ${effectiveStepTimeoutMs}ms: ${stepId || '<no-id>'} | ${stepDescription || '<no-description>'}`))
              }, effectiveStepTimeoutMs)
            }),
          ])
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle)
          }
        }
      })

      const skipped = Boolean(
        executeResult &&
        typeof executeResult === 'object' &&
        executeResult.__scenarioStepStatus === 'skipped'
      )
      const noop = Boolean(
        executeResult &&
        typeof executeResult === 'object' &&
        executeResult.__scenarioStepStatus === 'noop'
      )
      const status = skipped ? 'skipped' : 'executed'
      const skipReason = skipped ?
        String(executeResult.reason || 'step guard condition was not met') :
        null

      const endedAtMs = Date.now()
      const endedAtIso = new Date(endedAtMs).toISOString()

      const statusText = skipped ? `SKIPPED (${skipReason})` : 'EXECUTED'
      console.log(`[scenario-step] ${stepId} | ${stepDescription} | ${statusText} | ${startedAtIso} -> ${endedAtIso} (${endedAtMs - startedAtMs}ms)`)

      const shouldWaitAfterStep = !skipped && !noop
      if (videoModeEnabled && waitBetweenStepsMs > 0 && shouldWaitAfterStep && page) {
        await page.waitForTimeout(waitBetweenStepsMs)
      }

      timeline.push({
        stepId,
        stepDescription,
        status,
        skipped,
        skipReason,
        startedAtMs,
        endedAtMs,
        startedAtIso,
        endedAtIso,
        durationMs: endedAtMs - startedAtMs,
      })

      return executeResult
    },

    async flush() {
      const timelineReport = {
        scenarioId,
        scenarioVersion,
        scenarioSource,
        generatedAtIso: new Date().toISOString(),
        steps: timeline,
      }

      const timelinePath = testInfo.outputPath('scenario-step-timeline.json')
      await writeFile(timelinePath, JSON.stringify(timelineReport, null, 2), 'utf8')
      console.log(`[scenario-step] timeline report: ${timelinePath}`)
    },
  }
}
