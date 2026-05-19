import { test, expect } from '@playwright/test'
import { buildRunId } from './support/test-helper.js'


test.describe('Plaintext Editor Einfügeposition', () => {
  test('speichert neue Anforderungen an der eingefügten Position', async ({ page }, testInfo) => {
    const runId = `${buildRunId(testInfo)}-insert-position`
    const specTitle = `E2E Spec Insert Position ${runId}`
    const firstLabel = `E2E Erste Anforderung`
    const insertedLabel = `E2E Eingefügte Anforderung in der Mitte`
    const secondLabel = `E2E Zweite Anforderung`

    const systemPage = new SystemPage(page)
    const specificationPage = new SpecificationPage(page)
    const requirementPage = new RequirementPage(page)

    await systemPage.login()
    await specificationPage.createSpecification(specTitle)
    await specificationPage.openSpecViewerByTitle(specTitle)

    await requirementPage.ensurePlainTextMode()
    await requirementPage.appendEditorLines([
      `A: ${firstLabel}`,
      `A: ${secondLabel}`,
    ])
    await requirementPage.savePlaintext()

    const firstSavedContent = await requirementPage.getEditorText()
    const firstSavedLines = firstSavedContent.split('\n')
    const firstIndex = firstSavedLines.findIndex((line) => line.includes(firstLabel))
    if (firstIndex < 0) {
      throw new Error(`Erste Anforderung nicht gefunden: ${firstLabel}`)
    }

    const withInsertedRequirement = [
      ...firstSavedLines.slice(0, firstIndex + 1),
      `A: ${insertedLabel}`,
      ...firstSavedLines.slice(firstIndex + 1),
    ].join('\n')

    console.log(withInsertedRequirement);

    await requirementPage.setEditorText(withInsertedRequirement)
    await requirementPage.savePlaintext()

    await specificationPage.openSpecViewerByTitle(specTitle)
    await requirementPage.ensurePlainTextMode()

    const persistedContent = await requirementPage.getEditorText()
    const persistedLines = persistedContent.split('\n')
    const persistedFirstIndex = persistedLines.findIndex((line) => line.includes(firstLabel))
    const persistedInsertedIndex = persistedLines.findIndex((line) => line.includes(insertedLabel))
    const persistedSecondIndex = persistedLines.findIndex((line) => line.includes(secondLabel))
    const requirementLines = persistedLines.filter((line) => /^\s*(?:[0-9A-Z]+-A\d{3}[a-z]?|A\d{3}[a-z]?|Anforderung-\d+)\s*:/i.test(line))

    expect(persistedFirstIndex).toBeGreaterThanOrEqual(0)
    expect(persistedInsertedIndex).toBeGreaterThan(persistedFirstIndex)
    expect(persistedSecondIndex).toBeGreaterThan(persistedInsertedIndex)
    expect(requirementLines).toHaveLength(3)
  })
})
