import {
  test,
  expect
} from '@playwright/test'

import {
  buildRunId,
} from './support/test-helper.js'
import {
  runActionAndExpectFeedback
} from './support/feedback-assertions.js'
import { DemoRun } from './demo/demo-run.ts'

test.describe('Plaintext Regelwerk mit Ideenanker', () => {
  test('Case 1: Erfassung einer Anforderung ohne AnforderungsID', async ({
    page,
  }, testInfo) => {
    const runId = `${buildRunId(testInfo)}-c1`
    const ideaTitle = `E2E Idee Regelwerk ${runId}`
    const targetSpecTitle = `E2E Spec Ziel ${runId}`

    let systemPage = new SystemPage(page)
    let ideaPage = new IdeaPage(page)
    let specificationPage = new SpecificationPage(page)
    let requirementPage = new RequirementPage(page)

    const demoRun = new DemoRun(page, testInfo)

    demoRun.narrateBetween({
      id: 'narration-c1-setup',
      startAfterClick: 'c1-setup-start',
      endBeforeClick: 'c1-capture-start',
      text: 'Wir melden uns an, erstellen eine neue Idee und setzen sie als Planungsanker. Danach legen wir eine Spezifikation an, in der wir gleich eine neue Anforderung erfassen werden.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c1-capture',
      startAfterClick: 'c1-capture-start',
      endBeforeClick: 'c1-verify-start',
      text: 'Im Plaintext-Editor erfassen wir eine neue Anforderung ohne vorhandene ID. Bereits vor dem Speichern zeigt der Zeilennummern-Marker ein Plus, das die neue Anforderung ankündigt. Nach dem Speichern bleibt der Marker erhalten.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c1-verify',
      startAfterClick: 'c1-verify-start',
      endBeforeClick: 'c1-verify-end',
      text: 'In der Ideen-Zusammenfassung ist die neue Anforderung als geplante Neuanlage mit einem Plus-Marker sichtbar.',
      voice: 'de-DE-Neural2-B'
    })

    try {
      demoRun.mark('c1-setup-start')
      await test.step('Setup: Login, Idee mit Anker und eine Spezifikation', async () => {
      await systemPage.login()

      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.createIdea(ideaTitle)
      await ideaPage.setIdeaAsAnchor()

      await specificationPage.navigateViaMainTab()
      await specificationPage.ensureAllMainPanelsVisible()
      await specificationPage.createSpecification(targetSpecTitle)
    })

    demoRun.mark('c1-capture-start')
    const label = `CASE1 neue Anforderung ${runId}`
    await test.step('Anforderung im Zielviewer per Plaintext erfassen', async () => {
      await specificationPage.openSpecViewerByTitle(targetSpecTitle)
      await requirementPage.ensurePlainTextMode()
      await requirementPage.appendEditorLines([
        `A: ${label}`,
        'G: automatisch angelegt'
      ])

      //Plus erscheint bereits vor dem Speichern
      await requirementPage.expectPlaintextLineNumberMarkerForLine({
        lineSubstring: label,
        expectedMarker: '+'
      })

      await requirementPage.savePlaintext()

      //Plus erscheint nach dem Speichern
      await requirementPage.expectPlaintextLineNumberMarkerForLine({
        lineSubstring: label,
        expectedMarker: '+'
      })
    })

    demoRun.mark('c1-verify-start')
    await test.step('Ideen-Zusammenfassung auf Plus-Marker prüfen', async () => {
      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.openIdeaByTitle(ideaTitle)
      await ideaPage.expectSummaryCountsForSpec(targetSpecTitle, {
        plus: 1,
        minus: 0,
        movePlus: 0,
        moveMinus: 0,
      })
    })
    demoRun.mark('c1-verify-end')
    } finally {
      await demoRun.finish({ runId })
    }
  })

  test('Case 2: Löschung einer abgestimmten Anforderung', async ({
    page,
  }, testInfo) => {
    const runId = `${buildRunId(testInfo)}-c2`
    const ideaTitle = `E2E Idee Regelwerk ${runId}`
    const sourceSpecTitle = `E2E Spec Quelle ${runId}`
    const targetSpecTitle = `E2E Spec Ziel ${runId}`
    const followUpIdeaTitle = `E2E Idee Regelwerk Folge ${runId}`
    const label = `CASE2 fehlt abgestimmt ${runId}`

    let systemPage = new SystemPage(page)
    let specificationPage = new SpecificationPage(page)
    let requirementPage = new RequirementPage(page)
    let ideaPage = new IdeaPage(page)

    const demoRun = new DemoRun(page, testInfo)

    demoRun.narrateBetween({
      id: 'narration-c2-setup',
      startAfterClick: 'c2-setup-start',
      endBeforeClick: 'c2-abstimmen-start',
      text: 'Setup und Erfassung: Nach dem Login erstellen wir Idee, Anker und eine Spezifikation. Danach erfassen wir eine Anforderung per Plaintext und speichern sie.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c2-abstimmen',
      startAfterClick: 'c2-abstimmen-start',
      endBeforeClick: 'c2-delete-start',
      text: 'Wir setzen die Idee auf Angenommen und führen die Umsetzung durch. Die Anforderung gilt damit als abgestimmt.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c2-delete',
      startAfterClick: 'c2-delete-start',
      endBeforeClick: 'c2-verify-start',
      text: 'Mit einer neuen Folge-Idee als Anker entfernen wir die abgestimmte Anforderung aus dem Editor. Nach dem Speichern erscheint ein Minus-Marker an der Zeilennummer.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c2-verify',
      startAfterClick: 'c2-verify-start',
      endBeforeClick: 'c2-verify-end',
      text: 'Die Folge-Idee zeigt in ihrer Zusammenfassung die geplante Löschung als Minus-Marker.',
      voice: 'de-DE-Neural2-B'
    })

    try {
      demoRun.mark('c2-setup-start')
      await test.step('Setup: Login, Idee mit Anker und einer Spezifikation', async () => {
      await systemPage.login()

      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.createIdea(ideaTitle)
      await ideaPage.setIdeaAsAnchor()

      await specificationPage.navigateViaMainTab()
      await specificationPage.ensureAllMainPanelsVisible()
      await specificationPage.createSpecification(targetSpecTitle)
    })

    await test.step('Anforderung in Zielspec erfassen und initial speichern',
      async () => {
        await specificationPage.openSpecViewerByTitle(targetSpecTitle)
        await requirementPage.ensurePlainTextMode()
        await requirementPage.appendEditorLines([`A: ${label}`])
        await requirementPage.savePlaintext()
      })

    demoRun.mark('c2-abstimmen-start')
    await test.step('Ausgangsidee umsetzen, damit die Anforderung abgestimmt ist',
      async () => {
        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.openIdeaByTitle(ideaTitle)
        await ideaPage.setStatusAngenommen();
        await ideaPage.aenderungenUmsetzen();

      })

    demoRun.mark('c2-delete-start')
    await test.step(
      'Folgeidee anlegen, Anforderung entfernen und als geplant obsolet speichern',
      async () => {
        await ideaPage.createIdea(followUpIdeaTitle)
        await ideaPage.setIdeaAsAnchor()

        await specificationPage.openSpecViewerByTitle(targetSpecTitle)
        await requirementPage.ensurePlainTextMode()
        await requirementPage.removeRequirementBlockContaining(label)
        await requirementPage.savePlaintext()

        //Minus wird nach dem Speichern dargestellt 
        await requirementPage.expectPlaintextLineNumberMarkerForLine({
          lineSubstring: label,
          expectedMarker: '-'
        })
      })

    demoRun.mark('c2-verify-start')
    await test.step('Folge-Idee auf Minus-Marker prüfen', async () => {
      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.openIdeaByTitle(followUpIdeaTitle)
      await ideaPage.expectSummaryCountsForSpec(targetSpecTitle, {
        plus: 0,
        minus: 1,
        movePlus: 0,
        moveMinus: 0,
      })
    })
    demoRun.mark('c2-verify-end')
    } finally {
      await demoRun.finish({ runId })
    }
  })



  // Anforderung mit ID, die beim speichern fehlt, aber vorher abgestimmt war und nun in einer anderen Spezifikation vorhanden ist: Planung-Move-Out (Move-Marker)
  test(
    'Case 3: Erfassung der AnforderungsID einer bereits abgestimmten Anforderung in einer anderen Spezifikation',
    async ({
      page
    }, testInfo) => {
      const runId = `${buildRunId(testInfo)}-c3`
      const ideaTitle = `E2E Idee Regelwerk ${runId}`
      const sourceSpecTitle = `E2E Spec Quelle ${runId}`
      const targetSpecTitle = `E2E Spec Ziel ${runId}`
      const followUpIdeaTitle = `E2E Idee Regelwerk Folge ${runId}`
      const label = `CASE3 move-out quelle ${runId}`
      const targetLabel = `CASE3 move-in ziel ${runId}`

      let systemPage = new SystemPage(page)
      let specificationPage = new SpecificationPage(page)
      let requirementPage = new RequirementPage(page)
      let ideaPage = new IdeaPage(page)

      const demoRun = new DemoRun(page, testInfo)

      demoRun.narrateBetween({
        id: 'narration-c3-setup',
        startAfterClick: 'c3-setup-start',
        endBeforeClick: 'c3-quellspec-start',
        text: 'Setup: Wir melden uns an, erstellen eine Idee als Planungsanker und legen zwei Spezifikationen an — Quelle und Ziel.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c3-quellspec',
        startAfterClick: 'c3-quellspec-start',
        endBeforeClick: 'c3-folge-start',
        text: 'In der Quellspezifikation erfassen wir eine neue Anforderung per Plaintext und speichern sie. Anschließend setzen wir die Idee um — damit gilt die Anforderung als abgestimmt.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c3-folge',
        startAfterClick: 'c3-folge-start',
        endBeforeClick: 'c3-umzug-start',
        text: 'Mit einer Folge-Idee als neuem Anker tragen wir die Token-ID der abgestimmten Anforderung in die Zielspezifikation ein. Der Pfeil-Marker zeigt sofort: das System erkennt den geplanten Umzug.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c3-umzug',
        startAfterClick: 'c3-umzug-start',
        endBeforeClick: 'c3-verify-start',
        text: 'In der Quellspezifikation ist der rückwärtige Move-Marker sichtbar, der den Umzug aus der Quellseite bestätigt.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c3-verify',
        startAfterClick: 'c3-verify-start',
        endBeforeClick: 'c3-verify-end',
        text: 'Die Folge-Idee zeigt in ihrer Zusammenfassung einen Move-Plus für die Zielspezifikation und einen Move-Minus für die Quellspezifikation.',
        voice: 'de-DE-Neural2-B'
      })

      try {
      demoRun.mark('c3-setup-start')
      await test.step('Setup: Login, Idee mit Anker und zwei Spezifikationen', async () => {
        await systemPage.login()

        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.createIdea(ideaTitle)
        await ideaPage.setIdeaAsAnchor()

        await specificationPage.navigateViaMainTab()
        await specificationPage.ensureAllMainPanelsVisible()
        await specificationPage.createSpecification(sourceSpecTitle)
        await specificationPage.createSpecification(targetSpecTitle)
      })

      demoRun.mark('c3-quellspec-start')
      let sourceToken = ''
      await test.step('Quellspezifikation vorbereiten und Ausgangsidee umsetzen',
        async () => {
          await specificationPage.openSpecViewerByTitle(sourceSpecTitle)
          await requirementPage.ensurePlainTextMode()
          await requirementPage.appendEditorLines([`A: ${label}`])
          await requirementPage.savePlaintext()
          sourceToken = await requirementPage.getPersistedRequirementTokenByText(label)

          await ideaPage.navigateViaMainTab()
          await ideaPage.ensureAllMainPanelsVisible()
          await ideaPage.openIdeaByTitle(ideaTitle)
          await ideaPage.setStatusAngenommen();
          await ideaPage.aenderungenUmsetzen();
        })
      demoRun.mark('c3-folge-start')

      await test.step('Folge-Idee mit Anker anlegen und Requirement in Zielspec umhängen',
        async () => {
          await ideaPage.createIdea(followUpIdeaTitle)
          await ideaPage.setIdeaAsAnchor()

          await specificationPage.openSpecViewerByTitle(targetSpecTitle)
          await requirementPage.ensurePlainTextMode()
          await requirementPage.appendEditorLines([
            `${sourceToken}: ${targetLabel}`
          ])

          //Editor erkennt bereits vor dem Speichern den Umzug der Anforderung...
          await requirementPage.expectPlaintextLineNumberMarkerForLine({
            lineSubstring: [targetLabel, label],
            expectedMarker: '⇓'
          })

          await requirementPage.savePlaintext()

          //...und danach
          await requirementPage.expectPlaintextLineNumberMarkerForLine({
            lineSubstring: [targetLabel, label],
            expectedMarker: '⇓'
          })
        })
      demoRun.mark('c3-umzug-start')

      await test.step('Umzug in der Quellspezifikation prüfen', async () => {
        await specificationPage.openSpecViewerByTitle(sourceSpecTitle)
        await requirementPage.ensurePlainTextMode()
        await requirementPage.expectPlaintextLineNumberMarkerForLine({
          lineSubstring: [label, targetLabel],
          expectedMarker: '⇑'
        })
      })
      demoRun.mark('c3-verify-start')

      await test.step('Folge-Idee auf Move-Plus und Quellspec auf Move-Minus prüfen',
        async () => {
          await ideaPage.navigateViaMainTab()
          await ideaPage.ensureAllMainPanelsVisible()
          await ideaPage.openIdeaByTitle(followUpIdeaTitle)
          await ideaPage.expectSummaryCountsForSpec(targetSpecTitle, {
            plus: 0,
            minus: 0,
            movePlus: 1,
            moveMinus: 0,
          })
          await ideaPage.expectSummaryCountsForSpec(sourceSpecTitle, {
            plus: 0,
            minus: 0,
            movePlus: 0,
            moveMinus: 1,
          })
        })
      demoRun.mark('c3-verify-end')
      } finally {
        await demoRun.finish({ runId })
      }
    })

  test('Case 4: Löschung einer nicht abgestimmten Anforderung', async ({
    page
  }, testInfo) => {
    const runId = `${buildRunId(testInfo)}-c4`
    const ideaTitle = `E2E Idee Regelwerk ${runId}`
    const targetSpecTitle = `E2E Spec Ziel ${runId}`
    const label = `CASE4 loeschen nicht abgestimmt ${runId}`

    let systemPage = new SystemPage(page)
    let ideaPage = new IdeaPage(page)
    let specificationPage = new SpecificationPage(page)
    let requirementPage = new RequirementPage(page)

    const demoRun = new DemoRun(page, testInfo)

    demoRun.narrateBetween({
      id: 'narration-c4-setup',
      startAfterClick: 'c4-setup-start',
      endBeforeClick: 'c4-erfassen-start',
      text: 'Nach dem Login erstellen wir eine Idee als Planungsanker sowie eine Spezifikation.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c4-erfassen',
      startAfterClick: 'c4-erfassen-start',
      endBeforeClick: 'c4-entfernen-start',
      text: 'Wir erfassen eine neue Anforderung per Plaintext, speichern sie und lesen die vergebene Token-ID aus.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c4-entfernen',
      startAfterClick: 'c4-entfernen-start',
      endBeforeClick: 'c4-verify-start',
      text: 'Wir entfernen den gesamten Anforderungsblock per Token und speichern. Da die Anforderung noch nicht abgestimmt war, verschwindet sie ohne Planungseintrag.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c4-verify',
      startAfterClick: 'c4-verify-start',
      endBeforeClick: 'c4-verify-end',
      text: 'Der Editor enthält den Text der Anforderung nicht mehr — kein Minus-Marker, kein Planungseintrag.',
      voice: 'de-DE-Neural2-B'
    })

    try {
    demoRun.mark('c4-setup-start')
    await test.step('Setup: Login, Idee mit Anker und einer Spezifikationen', async () => {
      await systemPage.login()

      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.createIdea(ideaTitle)
      await ideaPage.setIdeaAsAnchor()

      await specificationPage.navigateViaMainTab()
      await specificationPage.ensureAllMainPanelsVisible()
      await specificationPage.createSpecification(targetSpecTitle)
    })

    demoRun.mark('c4-erfassen-start')
    let persistedToken = ''
    await test.step('Anforderung erfassen und persistierte ID ermitteln', async () => {
      await specificationPage.openSpecViewerByTitle(targetSpecTitle)
      await requirementPage.ensurePlainTextMode()
      await requirementPage.appendEditorLines([`A: ${label}`])
      await requirementPage.savePlaintext()
      persistedToken = await requirementPage.getPersistedRequirementTokenByText(
        label)
    })

    demoRun.mark('c4-entfernen-start')
    await test.step('Persistierte Requirement-ID entfernen und Speichern', async () => {
      await requirementPage.ensurePlainTextMode()
      await requirementPage.removeRequirementBlockByToken(persistedToken)
      await requirementPage.savePlaintext()
    })

    demoRun.mark('c4-verify-start')
    await test.step('Editor enthält gelöschte Anforderung nicht mehr', async () => {
      await requirementPage.expectPlainTextEditorNotToContainText(label)
    })
    demoRun.mark('c4-verify-end')
    } finally {
      await demoRun.finish({ runId })
    }
  })

  test('Case 5: Erfassung einer unbekannten AnforderungsID', async ({
    page
  }, testInfo) => {
    const runId = `${buildRunId(testInfo)}-c5`
    const ideaTitle = `E2E Idee Regelwerk ${runId}`
    const targetSpecTitle = `E2E Spec Ziel ${runId}`

    let systemPage = new SystemPage(page)
    let ideaPage = new IdeaPage(page)
    let specificationPage = new SpecificationPage(page)
    let requirementPage = new RequirementPage(page)

    const demoRun = new DemoRun(page, testInfo)

    demoRun.narrateBetween({
      id: 'narration-c5-setup',
      startAfterClick: 'c5-setup-start',
      endBeforeClick: 'c5-eingabe-start',
      text: 'Nach dem Login erstellen wir Idee, Anker und Spezifikation.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c5-eingabe',
      startAfterClick: 'c5-eingabe-start',
      endBeforeClick: 'c5-fehler-start',
      text: 'Wir fügen eine ID ein, die im System nicht existiert — und schauen, wie das System reagiert.',
      voice: 'de-DE-Neural2-B'
    })
    demoRun.narrateBetween({
      id: 'narration-c5-fehler',
      startAfterClick: 'c5-fehler-start',
      endBeforeClick: 'c5-fehler-end',
      text: 'Beim Speichern öffnet sich der Umzug-Dialog — und danach zeigt das System eine Fehlermeldung: die ID ist unbekannt und kann nicht zugeordnet werden.',
      voice: 'de-DE-Neural2-B'
    })

    try {
    demoRun.mark('c5-setup-start')
    await test.step('Setup: Login, Idee mit Anker und einer Spezifikationen', async () => {
      await systemPage.login()

      await ideaPage.navigateViaMainTab()
      await ideaPage.ensureAllMainPanelsVisible()
      await ideaPage.createIdea(ideaTitle)
      await ideaPage.setIdeaAsAnchor()

      await specificationPage.navigateViaMainTab()
      await specificationPage.ensureAllMainPanelsVisible()
      await specificationPage.createSpecification(targetSpecTitle)
    })

    demoRun.mark('c5-eingabe-start')
    await test.step('Unbekannte globale ID einfügen', async () => {
      await specificationPage.openSpecViewerByTitle(targetSpecTitle)
      await requirementPage.ensurePlainTextMode()
      await requirementPage.appendEditorLines([
        `A-99999999: CASE5 unbekannt ${runId}`
      ])
    })

    demoRun.mark('c5-fehler-start')
    await test.step('Speichern zeigt Umzug-Dialog und danach Error-Feedback aufgrund von unbekannter AnforderungsID', async () => {
      await runActionAndExpectFeedback(
        page,
        async () => {
          const dialogOpened = await requirementPage.expectPlaintextSaveDialogStatsAndConfirm([
            'Änderungen mit Freigabenotwendigkeit',
            'Umzug geplant:',
            '1'
          ], {
            expectClosed: false
          })
          expect(dialogOpened).toBe(true)
        }, {
          kind: 'error'
        }
      )
    })
    demoRun.mark('c5-fehler-end')
    } finally {
      await demoRun.finish({ runId })
    }
  })


  test(
    'Case 7: Erfassung der AnforderungsID einer geplant obsoleten Anforderung in einer anderen Spezifikation',
    async ({
      page
    }, testInfo) => {
      const runId = `${buildRunId(testInfo)}-c7`
      const ideaTitle = `E2E Idee Regelwerk ${runId}`
      const sourceSpecTitle = `E2E Spec Quelle ${runId}`
      const targetSpecTitle = `E2E Spec Ziel ${runId}`
      const label = `CASE7 source obsolet ${runId}`

      let systemPage = new SystemPage(page)
      let ideaPage = new IdeaPage(page)
      let specificationPage = new SpecificationPage(page)
      let requirementPage = new RequirementPage(page)

      const demoRun = new DemoRun(page, testInfo)

      demoRun.narrateBetween({
        id: 'narration-c7-setup',
        startAfterClick: 'c7-setup-start',
        endBeforeClick: 'c7-obsolet-start',
        text: 'Setup: Zwei Spezifikationen, eine Idee als Anker. In der Quellspezifikation erfassen wir eine Anforderung und stimmen die Idee ab.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c7-obsolet',
        startAfterClick: 'c7-obsolet-start',
        endBeforeClick: 'c7-move-start',
        text: 'Wir entfernen die abgestimmte Anforderung aus der Quellspezifikation. Sie wird damit als geplant obsolet markiert.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c7-move',
        startAfterClick: 'c7-move-start',
        endBeforeClick: 'c7-verify-start',
        text: 'Jetzt tragen wir die Token-ID der obsoleten Anforderung in die Zielspezifikation ein. Der System-Dialog bestätigt den geplanten Umzug, und der Pfeil-Marker erscheint.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c7-verify',
        startAfterClick: 'c7-verify-start',
        endBeforeClick: 'c7-verify-end',
        text: 'Die Ideen-Zusammenfassung zeigt Move-Plus in der Zielspezifikation und Move-Minus in der Quellspezifikation.',
        voice: 'de-DE-Neural2-B'
      })

      try {
      demoRun.mark('c7-setup-start')
      await test.step('Setup: Login, Idee mit Anker und zwei Spezifikationen', async () => {
        await systemPage.login()

        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.createIdea(ideaTitle)
        await ideaPage.setIdeaAsAnchor()

        await specificationPage.navigateViaMainTab()
        await specificationPage.ensureAllMainPanelsVisible()
        await specificationPage.createSpecification(sourceSpecTitle)
        await specificationPage.createSpecification(targetSpecTitle)
      })

      demoRun.mark('c7-abstimmen-start')
      const targetLabel = `CASE7 ziel ${runId}`
      let sourceToken = ''
      await test.step('Abgestimmte Requirement-ID aus Quellspec erzeugen', async () => {
        await specificationPage.openSpecViewerByTitle(sourceSpecTitle)
        await requirementPage.ensurePlainTextMode()
        await requirementPage.appendEditorLines([`A: ${label}`])
        await requirementPage.savePlaintext()
        sourceToken = await requirementPage.getPersistedRequirementTokenByText(label)

        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.openIdeaByTitle(ideaTitle)
        await ideaPage.setStatusAngenommen();
        await ideaPage.aenderungenUmsetzen();
      })

      demoRun.mark('c7-obsolet-start')
      await test.step('Requirement in Quellspec entfernen und als obsolet planen',
        async () => {
          await specificationPage.openSpecViewerByTitle(sourceSpecTitle)
          await requirementPage.ensurePlainTextMode()
          await requirementPage.removeRequirementBlockContaining(label)
          await requirementPage.savePlaintext()
        })

      demoRun.mark('c7-move-start')
      await test.step('Token in Zielspec verwenden und Move prüfen', async () => {
        await specificationPage.openSpecViewerByTitle(targetSpecTitle)
        await requirementPage.ensurePlainTextMode()
        await requirementPage.appendEditorLines([
          `${sourceToken}: ${targetLabel}`
        ])
        await requirementPage.expectPlaintextSaveDialogStatsAndConfirm([
          'Umzug geplant:', '1'
        ])

        //Move-Marker erscheint nach dem Speichern
        // Der Editor zeigt je nach Browser den Ziel- oder Quelltext der Anforderung,
        // daher beide als akzeptable Kandidaten übergeben.
        await requirementPage.expectPlaintextLineNumberMarkerForLine({
          lineSubstring: [targetLabel, label],
          expectedMarker: '⇓'
        })
        
      })

      demoRun.mark('c7-verify-start')
      await test.step('Ideen-Zusammenfassung auf Move-Plus prüfen', async () => {
        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.openIdeaByTitle(ideaTitle)
        await ideaPage.expectSummaryCountsForSpec(targetSpecTitle, {
          plus: 0,
          minus: 0,
          movePlus: 1,
          moveMinus: 0,
        })
        await ideaPage.expectSummaryCountsForSpec(sourceSpecTitle, {
          plus: 0,
          minus: 0,
          movePlus: 0,
          moveMinus: 1,
        })

      })
      demoRun.mark('c7-verify-end')
      } finally {
        await demoRun.finish({ runId })
      }

    })

  test(
    'Case 8: Erfassung der AnforderungsID einer nicht abgestimmten Anforderung in einer anderen Spezifikation',
    async ({
      page
    }, testInfo) => {
      const runId = `${buildRunId(testInfo)}-c8`
      const ideaTitle = `E2E Idee Regelwerk ${runId}`
      const sourceSpecTitle = `E2E Spec Quelle ${runId}`
      const targetSpecTitle = `E2E Spec Ziel ${runId}`
      const label = `CASE8 source neu ${runId}`

      let systemPage = new SystemPage(page)
      let ideaPage = new IdeaPage(page)
      let specificationPage = new SpecificationPage(page)
      let requirementPage = new RequirementPage(page)

      const demoRun = new DemoRun(page, testInfo)

      demoRun.narrateBetween({
        id: 'narration-c8-setup',
        startAfterClick: 'c8-setup-start',
        endBeforeClick: 'c8-quellspec-start',
        text: 'Setup: Zwei Spezifikationen, eine Idee als Anker.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c8-quellspec',
        startAfterClick: 'c8-quellspec-start',
        endBeforeClick: 'c8-summary1-start',
        text: 'In der Quellspezifikation erfassen wir eine neue Anforderung und lesen die vergebene Token-ID aus.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c8-summary1',
        startAfterClick: 'c8-summary1-start',
        endBeforeClick: 'c8-zielspec-start',
        text: 'Die Idee zeigt bereits einen Plus-Marker für die Quellspezifikation.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c8-zielspec',
        startAfterClick: 'c8-zielspec-start',
        endBeforeClick: 'c8-verify-start',
        text: 'Jetzt tragen wir die Token-ID in der Zielspezifikation ein. Da die Anforderung dort noch nicht abgestimmt war, wird sie als neu interpretiert — kein Move, sondern ein Plus-Marker.',
        voice: 'de-DE-Neural2-B'
      })
      demoRun.narrateBetween({
        id: 'narration-c8-verify',
        startAfterClick: 'c8-verify-start',
        endBeforeClick: 'c8-verify-end',
        text: 'Die Zusammenfassung zeigt Plus eins in der Zielspezifikation. Die Quellspezifikation wurde zurückgesetzt auf null — die Anforderung wurde umgewidmet, nicht umgezogen.',
        voice: 'de-DE-Neural2-B'
      })

      try {
      demoRun.mark('c8-setup-start')
      await test.step('Setup: Login, Idee mit Anker und zwei Spezifikationen', async () => {
        await systemPage.login()

        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.createIdea(ideaTitle)
        await ideaPage.setIdeaAsAnchor()

        await specificationPage.navigateViaMainTab()
        await specificationPage.ensureAllMainPanelsVisible()
        await specificationPage.createSpecification(sourceSpecTitle)
        await specificationPage.createSpecification(targetSpecTitle)
      })

      demoRun.mark('c8-quellspec-start')
      let sourceToken = ''
      await test.step('Neue Requirement-ID in Quellspec erzeugen', async () => {
        await specificationPage.openSpecViewerByTitle(sourceSpecTitle)
        await requirementPage.ensurePlainTextMode()
        await requirementPage.appendEditorLines([`A: ${label}`])
        await requirementPage.savePlaintext()
        sourceToken = await requirementPage.getPersistedRequirementTokenByText(label)
      })

      demoRun.mark('c8-summary1-start')
      await test.step('Ideen-Zusammenfassung  prüfen', async () => {
        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.openIdeaByTitle(ideaTitle)
        await ideaPage.expectSummaryCountsForSpec(sourceSpecTitle, {
          plus: 1,
          minus: 0,
          movePlus: 0,
          moveMinus: 0,
        })
        
      })
      

      demoRun.mark('c8-zielspec-start')
      await test.step('Token in Zielspec verwenden und Plus-Marker prüfen', async () => {
        await specificationPage.openSpecViewerByTitle(targetSpecTitle)
        await requirementPage.ensurePlainTextMode()
        await requirementPage.appendEditorLines([
          `${sourceToken}: CASE8 ziel ${runId}`
        ])
        await requirementPage.savePlaintext()
        await requirementPage.expectPlaintextLineNumberMarkerForLine({
          lineSubstring: [`CASE8 ziel ${runId}`, label],
          expectedMarker: '+'
        })
      })

      demoRun.mark('c8-verify-start')
       await test.step('Ideen-Zusammenfassung prüfen', async () => {
        await ideaPage.navigateViaMainTab()
        await ideaPage.ensureAllMainPanelsVisible()
        await ideaPage.openIdeaByTitle(ideaTitle)
        await ideaPage.expectSummaryCountsForSpec(targetSpecTitle, {
          plus: 1,
          minus: 0,
          movePlus: 0,
          moveMinus: 0,
        })
        await ideaPage.expectSummaryCountsForSpec(sourceSpecTitle, {
          plus: 0,
          minus: 0,
          movePlus: 0,
          moveMinus: 0,
        })
        
      })
      demoRun.mark('c8-verify-end')
      } finally {
        await demoRun.finish({ runId })
      }
    })


})
