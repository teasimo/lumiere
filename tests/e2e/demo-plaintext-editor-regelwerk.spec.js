import {
  test,
  expect
} from '@playwright/test'
import {
  buildRunId
} from './support/test-helper.js'
import {
  runActionAndExpectFeedback
} from './support/feedback-assertions.js'
import {
  DemoRun
} from './demo/demo-run.js'

test.describe('Plaintext Regelwerk Demo fuer Schulungsvideo', () => {

  test('demonstriert die Regelwerk-Faelle schrittweise in einem Ablauf', async ({
    page
  }, testInfo) => {
    const runId = buildRunId(testInfo)

    const preparationIdeaTitle = `Demo Regelwerk Vorbereitung ${runId}`
    const case1IdeaTitle = `Demo Regelwerk Fall 1 ${runId}`
    const case2IdeaTitle = `Demo Regelwerk Fall 2 ${runId}`
    const case3IdeaTitle = `Demo Regelwerk Fall 3 ${runId}`
    const case4IdeaTitle = `Demo Regelwerk Fall 4 ${runId}`
    const case7IdeaTitle = `Demo Regelwerk Fall 7 ${runId}`
    const case8IdeaTitle = `Demo Regelwerk Fall 8 ${runId}`
    const case5IdeaTitle = `Demo Regelwerk Fall 5 ${runId}`

    const freshSpecTitle = `Demo Spec Neu ${runId}`
    const agreedSourceSpecTitle = `Demo Spec Quelle Abgestimmt ${runId}`
    const agreedTargetSpecTitle = `Demo Spec Ziel Abgestimmt ${runId}`
    const draftSourceSpecTitle = `Demo Spec Quelle Entwurf ${runId}`
    const draftTargetSpecTitle = `Demo Spec Ziel Entwurf ${runId}`
    const errorSpecTitle = `Demo Spec Fehler ${runId}`

    const case1Label = `DEMO CASE1 neue Anforderung ${runId}`
    const agreedDeleteLabel = `DEMO AGREED delete ${runId}`
    const agreedMoveLabel = `DEMO AGREED move ${runId}`
    const agreedObsoleteLabel = `DEMO AGREED obsolet ${runId}`
    const case3TargetLabel = `DEMO CASE3 move ziel ${runId}`
    const case4Label = `DEMO CASE4 loeschen entwurf ${runId}`
    const case7TargetLabel = `DEMO CASE7 move aus obsolet ${runId}`
    const case8SourceLabel = `DEMO CASE8 quelle neu ${runId}`
    const case8TargetLabel = `DEMO CASE8 ziel neu ${runId}`
    const case5UnknownLabel = `DEMO CASE5 unbekannt ${runId}`

    const systemPage = new SystemPage(page)
    const ideaPage = new IdeaPage(page)
    const specificationPage = new SpecificationPage(page)
    const requirementPage = new RequirementPage(page)
    const demoRun = new DemoRun(page, testInfo)

    let agreedMoveToken = ''
    let agreedObsoleteToken = ''




    demoRun.setVideoTitle(
      'Schulung' + '\n'+'Anforderungsänderungen im Rahmen einer Idee im Plaintext-Editor')

    demoRun.startVideoAfter('step-preparation-end')

    try {
      await test.step(
        'Vorbereitung: abgestimmte Ausgangslage fuer spaetere Faelle komplett herstellen',
        async () => {
          demoRun.mark('step-preparation-start')

          await systemPage.login()

          await ideaPage.navigateViaMainTab()
          await ideaPage.ensureAllMainPanelsVisible()
          await ideaPage.createIdea(preparationIdeaTitle)
          await ideaPage.setIdeaAsAnchor()

          await specificationPage.navigateViaMainTab()
          await specificationPage.ensureAllMainPanelsVisible()
          await specificationPage.createSpecification(freshSpecTitle)

          await requirementPage.navigateViaMainTab()
          await requirementPage.openSpecificationInViewer(freshSpecTitle)
          await requirementPage.ensurePlainTextMode()
          await requirementPage.appendEditorLines([
            `A: ${agreedDeleteLabel}`,
            'Info: Die Anforderung ist abgestimmt',
          ])

          await requirementPage.appendEditorLines([
            `A: Noch eine weitere abgestimmte Anforderung`,
          ])
          await requirementPage.savePlaintext();
          await requirementPage.openCurrentPlanungsanker();
          await ideaPage.setStatusAngenommen();
          await ideaPage.aenderungenUmsetzen();

          // await specificationPage.createSpecification(agreedSourceSpecTitle)
          // await specificationPage.createSpecification(agreedTargetSpecTitle)
          // await specificationPage.createSpecification(draftSourceSpecTitle)
          // await specificationPage.createSpecification(draftTargetSpecTitle)
          // await specificationPage.createSpecification(errorSpecTitle)

          // await openSpecInPlainText(agreedSourceSpecTitle)
          // await requirementPage.appendEditorLines([
          //   `A: ${agreedDeleteLabel}`,
          //   `A: ${agreedMoveLabel}`,
          //   `A: ${agreedObsoleteLabel}`,
          // ])
          // await requirementPage.savePlaintext()

          // agreedMoveToken = await requirementPage.getPersistedRequirementTokenByText(
          //   agreedMoveLabel)
          // agreedObsoleteToken = await requirementPage
          //   .getPersistedRequirementTokenByText(agreedObsoleteLabel)

          // await openIdeaSummary(preparationIdeaTitle)
          // await ideaPage.setStatusAngenommen()
          // await ideaPage.aenderungenUmsetzen()

          await systemPage.navigateViaMainTab();
          demoRun.mark('step-preparation-end')
        })


      await test.step('Vorbereitung: Ideen-Referenz-Anker setzen', async () => {
        demoRun.mark('step-prep-idee-start')
        demoRun.narrate({
          id: 'narration-prep-anchor',
          text: [
            'Willkommen zur Demonstration des Plaintext-Editors im Anforderungsviewer.',
            'Änderungen müssen immer im Rahmen einer Idee erfasst werden. Daher legen wir im ersten Schritt eine neue Idee an und setzen sie als Referenz-Anker.',
          ].join(' '),
          voice: 'de-DE-Neural2-B'
        })


        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.createIdea(case1IdeaTitle)
        await ideaPage.setIdeaAsAnchor()

        demoRun.mark('step-prep-idee-end')

      });

      demoRun.narrate({
          id: 'narration-prep-anchor',
          text: [
            'Nun betrachten wir die Möglichen Anwendungsfälle zur Änderungen von Anforderungen im Plaintext-Editor.',
          ].join(' '),
          voice: 'de-DE-Neural2-B'
        })

      await test.step('Fall 1: Erstellen einer neuen Anforderung',
        async () => {
          
          demoRun.stepTitle('Fall 1: Erstellen einer neuen Anforderung')

          demoRun.mark('step-case1-start')
          demoRun.narrate({
            id: 'narration-case1',
            text: [
              'Fall eins im Umgang mit dem Plaintext-Editor zeigt die einfachste Variante.',
              'Wir erfassen eine neue Anforderung. Demnach hat diese natürlich noch keine Anforderungsidentifikationsnummer.',
              'Neue Anforderungen werden anhand des Präfixes A Doppelpunkt oder auch A x x x Doppeltpunkt erkannt.',
              'Zusätzlich zu der Anforderung können Geschäftsregeln, Infos oder Klärungsbedarfe erfasst werden.',
              'Der Plus-Marker an der Zeilennummer macht sofort sichtbar, dass hier eine neue Anforderung geplant ist.'
            ].join(' '),
            voice: 'de-DE-Neural2-B'
          })


          await requirementPage.navigateViaMainTab()
          await requirementPage.openSpecificationInViewer(freshSpecTitle)
          await requirementPage.ensurePlainTextMode()
          await requirementPage.appendEditorLines([
            '',
            `A: ${case1Label}`,
            'Geschäftsregeln: Nur Sonntags erlaubt',
            'Info: weitere Informationen',
            'Klärungsbedarf: Klärungsbedarf hier',
          ])

          await requirementPage.appendEditorLines([
            '',
            `Axxx: ${case1Label} - andere Schreibweise`,
            'Geschäftsregeln: Auch Montags erlaubt',
            'Info: noch mehr weitere Informationen',
            'Klärungsbedarf: Diese Anforderung sollte überdacht werden',
          ])

          demoRun.mark('step-case1-save')
          demoRun.narrate({
            id: 'narration-case1',
            text: [
              'Der Speicherdialog zeigt eine Zusammenfassung der erkannten Änderungen.',
              'Hier kann bei Bedarf die Idee angepasst werden im Rahmen dessen die Anforderungen erstellt werden.',
            ].join(' '),
            voice: 'de-DE-Neural2-B'
          })


          await requirementPage.savePlaintext()
          await page.waitForTimeout(800)



          demoRun.mark('step-case1-Idee')

          demoRun.narrate({
            id: 'narration-case1-idee',
            text: [
              'Die geplanten Änderungen können nun auch in der Idee eingesehen werden.',
            ].join(' '),
            voice: 'de-DE-Neural2-B'
          })

          await requirementPage.openCurrentPlanungsanker()

          demoRun.mark('step-case1-end')
        })

      await test.step('Fall 2: Abgestimmte Anforderung löschen',
        async () => {
          
          demoRun.stepTitle('Fall 2: Abgestimmte Anforderung löschen')

          demoRun.mark('step-case2-start')
          demoRun.narrate({
            id: 'narration-case2',
            text: [
              'Fall zwei im Umgang mit dem Plaintext-Editor demonstriert die geplante Obsoleszenz einer bereits abgestimmten Anforderung.',
              'Weil diese Anforderung schon abgestimmt war, wird sie nicht sofort gelöscht.',
              'Stattdessen entsteht eine geplante Obsolet-Markierung mit Minus-Symbol.'
            ].join(' '),
            voice: 'de-DE-Neural2-B'
          })

          await requirementPage.navigateViaMainTab()
          await requirementPage.openSpecificationInViewer(freshSpecTitle)
          await requirementPage.ensurePlainTextMode()

          await requirementPage.removeRequirementBlockContaining(agreedDeleteLabel)
          await requirementPage.savePlaintext()

          await page.waitForTimeout(800)

          demoRun.mark('step-case2-Idee')

          

          await requirementPage.openCurrentPlanungsanker()

          demoRun.mark('step-case2-end')
        })


      await test.step(
        'Fall 3: nicht abgestimmte Anforderung verschwindet ohne Planungseintrag',
        async () => {
          
          demoRun.stepTitle('Fall 3: Nicht abgestimmte Anforderung löschen')

          demoRun.mark('step-case3-start')
          demoRun.narrate({
            id: 'narration-case3',
            text: [
              'Fall drei im Umgang mit dem Plaintext-Editor unterscheidet sich dazu. Die Löschung einer noch nicht abgestimmten Anforderung wird ohne nachvollziehbare Spuren umgesetzt.',
              'Wir legen nun eine Anforderung an. Damit ist sie nicht abgestimmt. Und dann entfernen wir sie wieder.',
              'Da die Anforderung nicht abgestimmt war, wird sie ohne jegliche Dokumentationen gelöscht.'
            ].join(' '),
            voice: 'de-DE-Neural2-B'
          })

          await requirementPage.navigateViaMainTab()
          await requirementPage.openSpecificationInViewer(freshSpecTitle)
          await requirementPage.ensurePlainTextMode()

          await requirementPage.appendEditorLines([
            `A: Nicht abgestimmte temporäre Anforderung`,
          ])

          await requirementPage.savePlaintext();

          await page.waitForTimeout(800)

          await requirementPage.removeRequirementBlockContaining(
            'Nicht abgestimmte temporäre Anforderung')


          await requirementPage.savePlaintext();

          await page.waitForTimeout(800)

           demoRun.mark('step-case3-Idee')

          demoRun.narrate({
            id: 'narration-case3',
            text: [
              'Auch die geplanten Änderungen können nun in der Idee eingesehen werden.',
            ].join(' '),
            voice: 'de-DE-Neural2-B'
          })

          await requirementPage.openCurrentPlanungsanker()


          demoRun.mark('step-case3-end')
        })

        demoRun.stepTitle('Fortsetzung folgt...')

      // await test.step(
      //   'Fall 3: abgestimmte Token-ID in anderer Spezifikation wird als Move erkannt',
      //   async () => {
      //     demoRun.mark('step-case3-start')
      //     demoRun.narrate({
      //       id: 'narration-case3',
      //       text: [
      //         'Fall drei zeigt den Umzug einer abgestimmten Anforderung in eine andere Spezifikation.',
      //         'Hier tragen wir die bestehende Anforderungsidentifikationsnummer in der anvisierten Spezifikation erneut ein.',
      //         'Der Editor erkennt diesen geplanten Umzug. Dieser wird in der Zeilennummer mittels des Download-Pfeils dargestellt.'
      //       ].join(' '),
      //       voice: 'de-DE-Neural2-B'
      //     })

      //     await createIdeaAndSetAnchor(case3IdeaTitle)
      //     await openSpecInPlainText(agreedTargetSpecTitle)
      //     await requirementPage.appendEditorLines([
      //       `${agreedMoveToken}: ${case3TargetLabel}`,
      //     ])
      //     await requirementPage.expectPlaintextLineNumberMarkerForLine({
      //       lineSubstring: [case3TargetLabel, agreedMoveLabel],
      //       expectedMarker: '⇓',
      //     })
      //     await requirementPage.savePlaintext()
      //     await requirementPage.expectPlaintextLineNumberMarkerForLine({
      //       lineSubstring: [case3TargetLabel, agreedMoveLabel],
      //       expectedMarker: '⇓',
      //     })

      //     await openSpecInPlainText(agreedSourceSpecTitle)
      //     await requirementPage.expectPlaintextLineNumberMarkerForLine({
      //       lineSubstring: [agreedMoveLabel, case3TargetLabel],
      //       expectedMarker: '⇑',
      //     })

      //     await openIdeaSummary(case3IdeaTitle)
      //     await ideaPage.expectSummaryCountsForSpec(agreedTargetSpecTitle, {
      //       plus: 0,
      //       minus: 0,
      //       movePlus: 1,
      //       moveMinus: 0,
      //     })
      //     await ideaPage.expectSummaryCountsForSpec(agreedSourceSpecTitle, {
      //       plus: 0,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 1,
      //     })

      //     demoRun.mark('step-case3-end')
      //   })


      // await test.step(
      //   'Fall 7: geplant obsolete abgestimmte Anforderung wird im Ziel als Move wiederverwendet',
      //   async () => {
      //     demoRun.mark('step-case7-start')
      //     demoRun.narrate({
      //       id: 'narration-case7',
      //       text: [
      //         'Fall sieben verbindet zwei Regeln.',
      //         'Zuerst machen wir aus einer abgestimmten Anforderung eine geplant obsolete Anforderung.',
      //         'Danach verwenden wir dieselbe Token-ID im Ziel wieder, wodurch das System den Umzug aus dem Obsolet-Plan erkennt.'
      //       ].join(' '),
      //       voice: 'de-DE-Neural2-B'
      //     })

      //     await createIdeaAndSetAnchor(case7IdeaTitle)
      //     await openSpecInPlainText(agreedSourceSpecTitle)
      //     await requirementPage.removeRequirementBlockContaining(agreedObsoleteLabel)
      //     await requirementPage.savePlaintext()
      //     await requirementPage.expectPlaintextLineNumberMarkerForLine({
      //       lineSubstring: agreedObsoleteLabel,
      //       expectedMarker: '-',
      //     })

      //     await openSpecInPlainText(agreedTargetSpecTitle)
      //     await requirementPage.appendEditorLines([
      //       `${agreedObsoleteToken}: ${case7TargetLabel}`,
      //     ])
      //     await requirementPage.expectPlaintextSaveDialogStatsAndConfirm([
      //       'Umzug geplant:',
      //       '1',
      //     ])
      //     await requirementPage.expectPlaintextLineNumberMarkerForLine({
      //       lineSubstring: [case7TargetLabel, agreedObsoleteLabel],
      //       expectedMarker: '⇓',
      //     })

      //     await openIdeaSummary(case7IdeaTitle)
      //     await ideaPage.expectSummaryCountsForSpec(agreedTargetSpecTitle, {
      //       plus: 0,
      //       minus: 0,
      //       movePlus: 1,
      //       moveMinus: 0,
      //     })
      //     await ideaPage.expectSummaryCountsForSpec(agreedSourceSpecTitle, {
      //       plus: 0,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 1,
      //     })

      //     demoRun.mark('step-case7-end')
      //   })

      // await test.step(
      //   'Fall 8: nicht abgestimmte Token-ID wird im Ziel erneut als Plus interpretiert',
      //   async () => {
      //     demoRun.mark('step-case8-start')
      //     demoRun.narrate({
      //       id: 'narration-case8',
      //       text: [
      //         'Fall acht zeigt die gleiche Token-Wiederverwendung fuer eine noch nicht abgestimmte Anforderung.',
      //         'Diesmal entsteht bewusst kein Move.',
      //         'Die Zielseite bekommt stattdessen wieder einen Plus-Eintrag wie bei einer Neuanlage.'
      //       ].join(' '),
      //       voice: 'de-DE-Neural2-B'
      //     })

      //     await createIdeaAndSetAnchor(case8IdeaTitle)
      //     await openSpecInPlainText(draftSourceSpecTitle)
      //     await requirementPage.appendEditorLines([`A: ${case8SourceLabel}`])
      //     await requirementPage.savePlaintext()

      //     const case8Token = await requirementPage.getPersistedRequirementTokenByText(
      //       case8SourceLabel)

      //     await openIdeaSummary(case8IdeaTitle)
      //     await ideaPage.expectSummaryCountsForSpec(draftSourceSpecTitle, {
      //       plus: 1,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 0,
      //     })

      //     await openSpecInPlainText(draftTargetSpecTitle)
      //     await requirementPage.appendEditorLines([
      //       `${case8Token}: ${case8TargetLabel}`,
      //     ])
      //     await requirementPage.savePlaintext()
      //     await requirementPage.expectPlaintextLineNumberMarkerForLine({
      //       lineSubstring: [case8TargetLabel, case8SourceLabel],
      //       expectedMarker: '+',
      //     })

      //     await openIdeaSummary(case8IdeaTitle)
      //     await ideaPage.expectSummaryCountsForSpec(draftTargetSpecTitle, {
      //       plus: 1,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 0,
      //     })
      //     await ideaPage.expectSummaryCountsForSpec(draftSourceSpecTitle, {
      //       plus: 0,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 0,
      //     })

      //     demoRun.mark('step-case8-end')
      //   })

      // await test.step(
      //   'Fall 5: unbekannte globale ID fuehrt beim Speichern zu einem Fehler',
      // async () => {
      //       demoRun.mark('step-case5-start')
      //       demoRun.narrate({
      //         id: 'narration-case5',
      //         text: [
      //           'Zum Abschluss zeigen wir noch den Fehlerfall.',
      //           'Wir geben eine Anforderungsidentifikationsnummer ein, die bislang nicht existiert.',
      //           'Beim Speichern erscheint eine Fehlermeldung, dass die Anforderung nicht existiert.'
      //         ].join(' '),
      //         voice: 'de-DE-Neural2-B'
      //       })

      //       await createIdeaAndSetAnchor(case5IdeaTitle)
      //       await openSpecInPlainText(errorSpecTitle)
      //       await requirementPage.appendEditorLines([
      //         `A-99999999: ${case5UnknownLabel}`,
      //       ])

      //       await runActionAndExpectFeedback(
      //         page,
      //         async () => {
      //           const dialogOpened = await requirementPage
      //             .expectPlaintextSaveDialogStatsAndConfirm([
      //               'Änderungen mit Freigabenotwendigkeit',
      //               'Umzug geplant:',
      //               '1',
      //             ], {
      //               expectClosed: false,
      //             })
      //           expect(dialogOpened).toBe(true)
      //         }, {
      //           kind: 'error',
      //         }
      //       )

      //       demoRun.mark('step-case5-end')
      //     })
    } finally {
      demoRun.mark('step-demo-end')
      await demoRun.finish({
        runId
      })
    }
  })
})
