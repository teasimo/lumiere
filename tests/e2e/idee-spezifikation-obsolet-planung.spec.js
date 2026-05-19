import { test, expect } from '@playwright/test'
import { runActionAndExpectFeedback } from './support/feedback-assertions.js'
import { buildRunId } from './support/test-helper.js'

const byTestId = (pageOrLocator, testId) => pageOrLocator.getByTestId(testId)

const ideaTestIds = {
  specSummaryTable: 'idee-view-spec-summary-table',
}

const specificationTestIds = {
  filterToggleButton: 'spezifikation-filter-toggle-button',
  filterSearchInput: 'spezifikation-filter-search-input',
  filterApplyButton: 'spezifikation-filter-apply-button',
  listTable: 'spezifikation-listview-table',
  detailView: 'spezifikation-view-container',
  viewMoreMenuButton: 'spezifikation-view-more-menu-button',
  viewMenuSoftDeleteItem: 'spezifikation-view-menu-soft-delete-item',
  viewSoftDeleteDialog: 'spezifikation-view-soft-delete-dialog',
  viewSoftDeleteConfirmButton: 'spezifikation-view-soft-delete-confirm-button',
}

test.describe('Idee-Planung fuer obsolet gesetzte Spezifikation', () => {
  test('speichert Soft-Delete mit Ideenanker auch als obsolet-Planung an der Idee', async ({
    page
  }, testInfo) => {
    const runParts = String(buildRunId(testInfo)).split('-')
    const runId = `${runParts[0]}-${runParts[1]}-${runParts[3]}-obsolet`
    const ideaTitle = `E2E Idee Obsolet ${runId}`
    const specTitle = `E2E Spezifikation Obsolet ${runId}`

    const systemPage = new SystemPage(page)
    const ideaPage = new IdeaPage(page)
    const specificationPage = new SpecificationPage(page)

    await test.step('Idee anlegen und als Planungsanker setzen', async () => {
      await systemPage.login()
      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()

      await ideaPage.createIdea(ideaTitle)
      await ideaPage.setIdeaAsAnchor()
    })

    await test.step('Spezifikation anlegen und oeffnen', async () => {
      await specificationPage.navigateViaMainTab()
      await specificationPage.createSpecification(specTitle)

      await specificationPage.ensurePanelOpen(specificationTestIds.filterToggleButton)
      await byTestId(page, specificationTestIds.filterSearchInput).fill(specTitle)
      await byTestId(page, specificationTestIds.filterApplyButton).click()

      const row = byTestId(page, specificationTestIds.listTable)
        .locator('tbody tr')
        .filter({ hasText: specTitle })
        .first()
      await expect(row).toBeVisible({ timeout: 15000 })
      await row.click()
      await expect(byTestId(page, specificationTestIds.detailView)).toBeVisible({ timeout: 15000 })
    })

    await test.step('Spezifikation soft-deleten und Feedback pruefen', async () => {
      await byTestId(page, specificationTestIds.viewMoreMenuButton).click()
      await byTestId(page, specificationTestIds.viewMenuSoftDeleteItem).click()
      await expect(byTestId(page, specificationTestIds.viewSoftDeleteDialog)).toBeVisible({ timeout: 10000 })

      await runActionAndExpectFeedback(
        page,
        async () => {
          await byTestId(page, specificationTestIds.viewSoftDeleteConfirmButton).click()
        },
        { kind: 'success' }
      )
    })

    await test.step('In der Idee ist die Spezifikation als obsolet geplant sichtbar', async () => {
      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.openIdeaByTitle(ideaTitle)

      const summaryTable = byTestId(page, ideaTestIds.specSummaryTable)
      await expect(summaryTable).toBeVisible({ timeout: 10000 })

      const specRow = summaryTable
        .locator('[data-testid="idee-spec-summary-row"]')
        .filter({ has: page.locator(`[data-testid="idee-spec-summary-title-cell"]:has-text("${specTitle}")`) })
        .first()
      await expect(specRow).toBeVisible({ timeout: 15000 })
      await expect(specRow.locator('[data-testid="idee-spec-summary-status-target-cell"]')).toHaveText('obsolet')
    })
  })
})
