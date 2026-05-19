import {
  test,
  expect
} from '@playwright/test'

const byTestId = (pageOrLocator, testId) => pageOrLocator.getByTestId(testId)
const byTestIdPrefix = (pageOrLocator, prefix) => pageOrLocator.locator(`[data-testid^="${prefix}"]`)

const appTestIds = {
  toggleLeftButton: 'app-header-toggle-left-button',
  toggleCenterButton: 'app-header-toggle-center-button',
}

const requirementViewerTestIds = {
  togglePlainTextButton: 'anforderungsviewer-toggle-plaintext-button',
  requirementRowPrefix: 'anforderungsviewer-requirement-row-',
}

const requirementDetailTestIds = {
  container: 'anforderung-detail-container',
  statusItemPrefix: 'anforderung-detail-status-item-',
  statusLabel: 'anforderung-detail-status-label',
}

import {
  buildRunId
} from './support/test-helper.js'
import {
  DemoRun
} from './demo/demo-run.ts'


test.describe('Idee-Planungsanker mit Plaintext-Umsetzung', () => {
  test(
    'legt Idee und Spezifikation an, erfasst Anforderungen per Plaintext und setzt die Idee um',
    async ({
      page
    }, testInfo) => {
      const runId = `${buildRunId(testInfo)}-flow`
      const ideaTitle = `Demo-Idee ${runId}`
      const specTitle = `Demo-Spezifikation ${runId}`

      const systemPage = new SystemPage(page)
      const ideaPage = new IdeaPage(page)
      const specificationPage = new SpecificationPage(page)
      const requirementPage = new RequirementPage(page)

      const demoRun = new DemoRun(page, testInfo)

      demoRun.setVideoTitle("Spezifikationen bearbeiten mit Ideen-Referenz-Anker")

      demoRun.narrateBetween({
        id: 'narration-setup-idea-anchor',
        startAfterClick: 'step-setup-start',
        endBeforeClick: 'step-setup-end',
        text: [
          'Willkommen im Demolauf für Änderungen im Rahmen eines Ideen-Referenz-Ankers.',
          'Zuerst erstellen wir eine neue Idee und setzen sie als Referenz-Anker.',
          'Damit werden alle folgenden Änderungen in den Spezifikationen mithilfe des Plaintext-Editors  dieser Idee zugeordnet.'
        ].join(' '),
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-spec-open',
        startAfterClick: 'step-spec-start',
        endBeforeClick: 'step-spec-end',
        text: [
          'Im zweiten Schritt wechseln wir in die Spezifikationen.',
          'Wir legen beispielhaft eine neue Spezifikation an und öffnen diese im Anforderungsviewer.',
        ].join(' '),
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-plaintext-capture',
        startAfterClick: 'step-plaintext-start',
        endBeforeClick: 'step-plaintext-end',
        text: [
          'Ab hier arbeiten wir mit dem Editor im Plaintext-Modus.',
          'Jetzt erfassen wir Kapitel, Abschnitte und mehrere Anforderungen als Plaintext.',
          'Die Plus-Markierungen neben den Zeilenummern zeigen, dass neue Elemente erkannt wurden.',
        ].join(' '),
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-idea-apply',
        startAfterClick: 'step-apply-start',
        endBeforeClick: 'step-apply-end',
        text: [
          'Nun öffnen wir die Idee und pruefen die zusammengefassten Änderungen je Spezifikation.',
          'Danach setzen wir den Status der Idee auf Angenommen und fuehren die Umsetzung aus.',
          'Damit gelten die Änderungen als abgestimmt.'
        ].join(' '),
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-status-check',
        startAfterClick: 'step-status-start',
        endBeforeClick: 'step-status-end',
        text: [
          'Zum Schluss entfernen wir den Referenz-Anker, um nur die Sicht auf abgestimmte Anforderungen zu haben.',
          'Die zuvor erfasste Anforderung wird nun in der Detailansicht als abgestimmt erscheinen.'
        ].join(' '),
        voice: 'de-DE-Neural2-B'
      })

      demoRun.startVideoAfter('step-setup-start');

      try {

        await test.step('Idee anlegen und als Referenz-Anker setzen', async () => {
          await systemPage.login()



          demoRun.mark('step-setup-start')
          await ideaPage.navigateViaMainTab()
          await ideaPage.ensureAllMainPanelsVisible()

          await ideaPage.createIdea(ideaTitle)
          await ideaPage.setIdeaAsAnchor()
        })
        demoRun.mark('step-setup-end')

        demoRun.mark('step-spec-start')
        await test.step('Spezifikation erstellen und Viewer öffnen', async () => {
          await specificationPage.navigateViaMainTab()
          await specificationPage.ensurePanelOpen(appTestIds.toggleLeftButton);
          await specificationPage.ensurePanelOpen(appTestIds.toggleCenterButton);
          await specificationPage.createSpecification(specTitle)          
        })
        demoRun.mark('step-spec-end')

        demoRun.mark('step-plaintext-start')
        await test.step('Neue Anforderungen und Kapitel erfassen', async () => {
          await requirementPage.navigateViaMainTab()
          await requirementPage.openSpecificationInViewer(specTitle)
          await requirementPage.ensurePlainTextMode()

          await requirementPage.appendEditorLines([
            `Kapitel: Ueberschrift des Kapitel1 ${runId}`,
            `Abschnitt: Spannender Abschnitt1 ${runId}`,
            `A: E2E-Anforderung 1 fuer ${runId}`,
            `A: E2E-Anforderung 2 fuer ${runId}`,
            `# Mittelinteressantes Kapitel2 ${runId}`,
            `Info: Das ist ein Info-Text fuer Kapitel2 ${runId}`,
            `## Hochgradig faszinierender Abschnitt2 ${runId}`,
            `Klärungsbedarf: Das ist ein Klärungsbedarf-Text fuer Abschnitt2 ${runId}`,
            `A: E2E-Anforderung 3 fuer ${runId}`,
            'Geschäftsregel: Wenn dies, dann das.',
            `Info: Das ist ein Info-Text fuer E2E-Anforderung 3 ${runId}`,
            `A: E2E-Anforderung 4 fuer ${runId}`,
            `Klärungsbedarf: Das ist ein Klärungsbedarf-Text fuer E2E-Anforderung 3 ${runId}`,
            `A: E2E-Anforderung 6 fuer ${runId}`,
            'G: Wenn dies, dann das - aber diesmal mit dem Geschäftsregel-Shortcut.',
          ])

          demoRun.mark('step-plaintext-end')

          await requirementPage.savePlaintext()

          await requirementPage.expectPlaintextLineNumberMarkerForLine({
            lineSubstring: `E2E-Anforderung 1 fuer ${runId}`,
            expectedMarker: '+'
          })
          await requirementPage.expectPlaintextLineNumberMarkerForLine({
            lineSubstring: `E2E-Anforderung 2 fuer ${runId}`,
            expectedMarker: '+'
          })
          await requirementPage.expectPlaintextLineNumberMarkerForLine({
            lineSubstring: `Ueberschrift des Kapitel1 ${runId}`,
            expectedMarker: '+'
          })
          await requirementPage.expectPlaintextLineNumberMarkerForLine({
            lineSubstring: `Spannender Abschnitt1 ${runId}`,
            expectedMarker: '+'
          })


        })


        demoRun.mark('step-apply-start')
        await test.step('Idee öffnen, Änderungen prüfen und Umsetzung anwenden', async () => {
          await ideaPage.navigateViaMainTab()
          await ideaPage.ensureAllMainPanelsVisible()
          await ideaPage.openIdeaByTitle(ideaTitle)

          await ideaPage.expectSummaryCountsForSpec(specTitle, {
            plus: 5,
            minus: 0,
            movePlus: 0,
            moveMinus: 0,
          })
          await ideaPage.setStatusAngenommen()
          await ideaPage.aenderungenUmsetzen()
        })
        demoRun.mark('step-apply-end')

        demoRun.mark('step-status-start')
        await test.step('Ohne Referenz-Anker Status der Anforderung prüfen', async () => {
          await ideaPage.clearIdeaAnchor()

          await requirementPage.navigateViaMainTab()
          await requirementPage.openSpecificationInViewer(specTitle)

          const plainTextToggle = byTestId(page, requirementViewerTestIds
            .togglePlainTextButton)
          if ((await plainTextToggle.getAttribute('aria-pressed')) === 'true') {
            await plainTextToggle.click()
            await expect(plainTextToggle).toHaveAttribute('aria-pressed', 'false')
          }

          await expect(page).not.toHaveURL(/[?&]idee=\d/)

          const requirementRow = byTestIdPrefix(page, requirementViewerTestIds
              .requirementRowPrefix)
            .filter({
              hasText: `E2E-Anforderung 1 fuer ${runId}`,
            })
            .first()
          await expect(requirementRow).toBeVisible({
            timeout: 15000,
          })
          await requirementRow.click()

          const detailContainer = byTestId(page, requirementDetailTestIds.container)
          await expect(detailContainer).toBeVisible({
            timeout: 15000,
          })

          const abgestimmtItem = byTestId(detailContainer,
            `${requirementDetailTestIds.statusItemPrefix}abgestimmt`)
          await expect(abgestimmtItem).toBeVisible({
            timeout: 15000,
          })
          await expect(byTestId(abgestimmtItem, requirementDetailTestIds.statusLabel))
            .toContainText(
              'Abgestimmt')
        })
        demoRun.mark('step-status-end')
      } finally {
        await demoRun.finish({
          runId,
          ideaTitle,
          specTitle,
        })
      }
    })
})
