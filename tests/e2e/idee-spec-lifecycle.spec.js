import { test, expect } from '@playwright/test'
import { ROOT_URL, buildRunId } from './support/test-helper.js'

const byTestId = (pageOrLocator, testId) => pageOrLocator.getByTestId(testId)

const ideaTestIds = {
  statusAngenommenNode: 'idee-view-status-angenommen-node',
  statusApplyConfirmDialog: 'idee-view-status-apply-confirm-dialog',
  statusApplyConfirmOkButton: 'idee-view-status-apply-confirm-ok-button',
  specSummaryTable: 'idee-view-spec-summary-table',
}

const specificationTestIds = {
  filterToggleButton: 'spezifikation-filter-toggle-button',
  filterSearchInput: 'spezifikation-filter-search-input',
  filterApplyButton: 'spezifikation-filter-apply-button',
  listTable: 'spezifikation-listview-table',
}

const appTestIds = {
  toggleLeftButton: 'app-header-toggle-left-button',
}

test.describe('Idee bestaetigen -> Spezifikation Lebenszyklus', () => {
  test('wechselt eine verknuepfte Spezifikation bei Bestaetigen der Idee von Entwurf auf Abgestimmt', async ({
    page
  }, testInfo) => {
    const runParts = String(buildRunId(testInfo)).split('-')
    const runId = `${runParts[0]}-${runParts[1]}-${runParts[3]}-lifecycle`
    const ideaTitle = `E2E Idee Lifecycle ${runId}`
    const specTitle = `E2E Spec Lifecycle ${runId}`

    const systemPage = new SystemPage(page)
    const ideaPage = new IdeaPage(page)
    const specificationPage = new SpecificationPage(page)
    const requirementPage = new RequirementPage(page)

    await test.step('Anmelden und Idee mit Planungsanker anlegen', async () => {
      await systemPage.login()
      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.createIdea(ideaTitle)
      await ideaPage.setIdeaAsAnchor()
    })

    await test.step('Neue Spezifikation mit Titel anlegen', async () => {
      await specificationPage.navigateViaMainTab()
      await specificationPage.createSpecification(specTitle)
    })

    await test.step('Spezifikation hat Lebenszyklus Entwurf', async () => {
      await specificationPage.navigateViaMainTab()
      await specificationPage.ensurePanelOpen(appTestIds.toggleLeftButton)
      await specificationPage.ensurePanelOpen(specificationTestIds.filterToggleButton)
      await byTestId(page, specificationTestIds.filterSearchInput).fill(specTitle)
      await byTestId(page, specificationTestIds.filterApplyButton).click()

      const row = byTestId(page, specificationTestIds.listTable)
        .locator('tbody tr')
        .filter({ hasText: specTitle })
        .first()
      await expect(row).toBeVisible({ timeout: 15000 })
      await expect(row).toContainText('Entwurf')
    })

    await test.step('Spezifikation im Anforderungsviewer oeffnen und Requirement anlegen', async () => {
      await specificationPage.openSpecViewerByTitle(specTitle)

      await requirementPage.ensurePlainTextMode()
      await requirementPage.appendEditorLines([
        `A: Lifecycle Requirement ${runId}`,
      ])
      await requirementPage.savePlaintext()
    })

    await test.step('Zurueck zur Idee und Status auf Angenommen setzen', async () => {
      await page.goto(`${ROOT_URL}/anfo/ideen`, { waitUntil: 'networkidle' })
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.openIdeaByTitle(ideaTitle)

      const angenommenNode = byTestId(page, ideaTestIds.statusAngenommenNode)
      await expect(angenommenNode).toBeVisible({ timeout: 10000 })
      if ((await angenommenNode.getAttribute('data-state')) === 'inactive') {
        await angenommenNode.click()
        const confirmDialog = byTestId(page, ideaTestIds.statusApplyConfirmDialog)
        if (await confirmDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
          await byTestId(page, ideaTestIds.statusApplyConfirmOkButton).click()
        }
      }
      await expect(angenommenNode).toHaveAttribute('data-state', 'active')
    })

    await test.step('Summary zeigt Entwurf mit Ziel abgestimmt', async () => {
      const summaryTable = byTestId(page, ideaTestIds.specSummaryTable)
      await expect(summaryTable).toBeVisible({ timeout: 10000 })

      const specRow = summaryTable
        .locator('[data-testid="idee-spec-summary-row"]')
        .filter({ has: page.locator(`[data-testid="idee-spec-summary-title-cell"]:has-text("${specTitle}")`) })
        .first()
      await expect(specRow).toBeVisible({ timeout: 10000 })

      await expect(specRow.locator('[data-testid="idee-spec-summary-lebenszyklus-cell"]')).toHaveText('Entwurf')
      await expect(specRow.locator('[data-testid="idee-spec-summary-status-target-cell"]')).toHaveText('abgestimmt')
    })

    await test.step('Anforderungsaenderungen bestaetigen', async () => {
      await ideaPage.aenderungenUmsetzen()
    })

    await test.step('Lebenszyklus ist in Summary und Liste nun Abgestimmt', async () => {
      const summaryTable = byTestId(page, ideaTestIds.specSummaryTable)
      await expect(summaryTable).toBeVisible({ timeout: 10000 })

      const specRow = summaryTable
        .locator('[data-testid="idee-spec-summary-row"]')
        .filter({ has: page.locator(`[data-testid="idee-spec-summary-title-cell"]:has-text("${specTitle}")`) })
        .first()
      await expect(specRow).toBeVisible({ timeout: 10000 })
      await expect(specRow.locator('[data-testid="idee-spec-summary-lebenszyklus-cell"]')).toHaveText('Abgestimmt', {
        timeout: 10000
      })

      await specificationPage.navigateViaMainTab()
      await specificationPage.ensurePanelOpen(appTestIds.toggleLeftButton)
      await specificationPage.ensurePanelOpen(specificationTestIds.filterToggleButton)
      await byTestId(page, specificationTestIds.filterSearchInput).fill(specTitle)
      await byTestId(page, specificationTestIds.filterApplyButton).click()

      const row = byTestId(page, specificationTestIds.listTable)
        .locator('tbody tr')
        .filter({ hasText: specTitle })
        .first()
      await expect(row).toBeVisible({ timeout: 15000 })
      await expect(row).toContainText('Abgestimmt')
    })
  })
})
