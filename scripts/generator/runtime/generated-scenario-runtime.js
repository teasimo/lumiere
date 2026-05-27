import { writeFile } from 'node:fs/promises'

export function createScenarioTimelineRuntime({
  test,
  testInfo,
  scenarioId,
  scenarioVersion,
  scenarioSource,
}) {
  const timeline = []

  return {
    async runStep(stepId, execute) {
      const startedAtMs = Date.now()
      const startedAtIso = new Date(startedAtMs).toISOString()

      const executeResult = await test.step(stepId, async () => {
        return execute()
      })

      const skipped = Boolean(
        executeResult
        && typeof executeResult === 'object'
        && executeResult.__scenarioStepStatus === 'skipped'
      )
      const status = skipped ? 'skipped' : 'executed'
      const skipReason = skipped
        ? String(executeResult.reason || 'step guard condition was not met')
        : null

      const endedAtMs = Date.now()
      const endedAtIso = new Date(endedAtMs).toISOString()

      timeline.push({
        stepId,
        status,
        skipped,
        skipReason,
        startedAtMs,
        endedAtMs,
        startedAtIso,
        endedAtIso,
        durationMs: endedAtMs - startedAtMs,
      })

      const statusText = skipped ? `SKIPPED (${skipReason})` : 'EXECUTED'
      console.log(`[scenario-step] ${stepId} | ${statusText} | ${startedAtIso} -> ${endedAtIso} (${endedAtMs - startedAtMs}ms)`)
    },

    async flush() {
      const timelineReport = {
        scenarioId,
        scenarioVersion,
        scenarioSource,
        generatedAtIso: new Date().toISOString(),
        steps: timeline,
      }

      const timelinePath = testInfo.outputPath('yaml-step-timeline.json')
      await writeFile(timelinePath, JSON.stringify(timelineReport, null, 2), 'utf8')
      console.log(`[scenario-step] timeline report: ${timelinePath}`)
    },
  }
}
