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

      await test.step(stepId, async () => {
        await execute()
      })

      const endedAtMs = Date.now()
      const endedAtIso = new Date(endedAtMs).toISOString()

      timeline.push({
        stepId,
        startedAtMs,
        endedAtMs,
        startedAtIso,
        endedAtIso,
        durationMs: endedAtMs - startedAtMs,
      })

      console.log(`[scenario-step] ${stepId} | ${startedAtIso} -> ${endedAtIso} (${endedAtMs - startedAtMs}ms)`)
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
