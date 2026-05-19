import {
  test,
  expect
} from '@playwright/test'
import {
  buildRunId,
  createUiTestApi,
  ROOT_URL,
  extractLineBySubstring
} from './support/test-helper.js'
import {
  erstelleIdeeUndSetzeReferenz,
  setzeIdeeAngenommenUndUebernehmeAnforderungsaenderungen
} from './domain-interactions/idee-domain-interactions.js'
import {
  DemoRun
} from './demo/demo-run.js'

import {
  erstelleSpezifikation,
  leseSpezifikationsInhalt,
  setzeSpezifikationsInhalt
}
from './domain-interactions/spezifikation-domain-interactons.js'

import {
  login
} from './domain-interactions/login-domain-interactions.js'


test.describe('Plaintext Regelwerk Demo fuer Schulungsvideo', () => {

  test('demonstriert die Regelwerk-Faelle schrittweise in einem Ablauf', async ({
    page
  }, testInfo) => {
    const runId = buildRunId(testInfo)

    const preparationIdeaTitle = `Demo Regelwerk Vorbereitung ${runId}`
    const case1IdeaTitle = `Demo Regelwerk Idee ${runId}`

    const sourceSpecTitle = `Spezifikation 1 / Quelle  ${runId}`
    const targetSpecTitle = `Spezifikation 2 / Ziel ${runId}`

    const case1Label = `DEMO CASE1 neue Anforderung ${runId}`
    const agreedMoveLabel = `Umzugsanforderung 1`
    const agreedMoveLabel2 = `Umzugsanforderung 2`
    const agreedObsoleteLabel = `Anforderung für die geplante Obsoleszenz`
    const case3TargetLabel = `DEMO CASE3 move ziel ${runId}`
    const case4Label = `DEMO CASE4 loeschen entwurf ${runId}`
    const case7TargetLabel = `DEMO CASE7 move aus obsolet ${runId}`
    const case8SourceLabel = `DEMO CASE8 quelle neu ${runId}`
    const case8TargetLabel = `DEMO CASE8 ziel neu ${runId}`
    const case5UnknownLabel = `DEMO CASE5 unbekannt ${runId}`

    const demoRun = new DemoRun(page, testInfo)

    let agreedMoveToken = ''
    let agreedObsoleteToken = ''




    demoRun.setVideoTitle(
      'Schulung' + '\n' +
      'Anforderungsänderungen im Rahmen einer Idee im Plaintext-Editor')

    demoRun.startVideoAfter('step-preparation-end')

    const ui = createUiTestApi(page, {
      demo: true
    })

    function removeRequirementBlockFromContent(content, textPart) {
      const lines = String(content ?? '').split(/\r?\n/)
      const start = lines.findIndex((line) => line.includes(textPart) && line.includes(
        ':'))
      if (start < 0) {
        throw new Error(`Requirement-Block nicht gefunden fuer: ${textPart}`)
      }

      let end = start + 1
      while (end < lines.length) {
        const line = String(lines[end] ?? '').trim()
        if (!line) {
          end += 1
          break
        }
        if (
          /^(Geschaeftsregeln|Geschaeftsregeln|G|Info|Klaerungsbedarf|Klärungsbedarf)\s*:/i
          .test(line)) {
          end += 1
          continue
        }
        break
      }

      return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
    }

    async function openSpecInPlainText(specTitle) {
      await ui.action('app-header-main-tab-Anforderungen')
      await ui.action('anforderungsviewer-left-tab-spezifikationen')
      await ensureSpezifikationListModeTable()
      await ui.ensure('spezifikation-filter-toggle-button')
      await ui.fill('spezifikation-filter-search-input', specTitle)
      await ui.clickRow('anforderungsviewer-spezifikationen-tableview', 1)
      await ui.ensure('anforderungsviewer-toggle-plaintext-button')
    }

    async function ensureSpezifikationListModeTable() {
      const modeToggle = page.getByTestId(
        'anforderungsviewer-spezifikationen-list-mode-toggle').first()
      await expect(modeToggle).toBeVisible()

      const currentMode = String(await modeToggle.getAttribute('data-state') ?? '')
      if (currentMode === 'table') return

      await modeToggle.getByRole('button', {
        name: 'Liste'
      }).click()
      await expect(modeToggle).toHaveAttribute('data-state', 'table')
    }

    async function appendEditorLines(lines) {
      await ui.append(
        'anforderungsviewer-plaintext-editor-content',
        `\n${lines.join('\n')}`, {
          outcome: 'ready'
        }
      )
    }

    async function savePlaintext() {
      const saveButton = page.getByTestId('anforderungsviewer-save-plaintext-button')
        .first()
      await expect(saveButton).toBeEnabled({
        timeout: 15000
      })
      await saveButton.click()
      await ui.action('app-confirm-ok-button', {
        outcome: 'saved'
      })
    }

    async function removeRequirementBlockContaining(textPart) {
      const content = await ui.read('anforderungsviewer-plaintext-editor-content')
      const nextContent = removeRequirementBlockFromContent(content, textPart)
      await ui.fill('anforderungsviewer-plaintext-editor-content', nextContent, {
        outcome: 'ready'
      })
    }

    async function openCurrentPlanungsanker() {
      await ui.action('anforderungsviewer-planungsanker-link-button')
    }

    try {
      await test.step(
        'Vorbereitung: abgestimmte Ausgangslage fuer spaetere Faelle komplett herstellen',
        async () => {


          await page.goto(`${ROOT_URL}/login`, {
            waitUntil: 'networkidle'
          })


          await login(ui, 'Schulte', 'test');

          await erstelleIdeeUndSetzeReferenz(ui, preparationIdeaTitle);

          await erstelleSpezifikation(ui, sourceSpecTitle);
          const content = await leseSpezifikationsInhalt(ui, sourceSpecTitle);
          await setzeSpezifikationsInhalt(ui, sourceSpecTitle, content + '\n\n' +
            `A: ${agreedMoveLabel}` + '\n\n' +
            `A: ${agreedObsoleteLabel} \n\n A: ${agreedMoveLabel2}`);

          await erstelleSpezifikation(ui, targetSpecTitle);

          await setzeIdeeAngenommenUndUebernehmeAnforderungsaenderungen(ui);

          // const content = await leseSpezifikationsInhalt(ui, freshSpecTitle);
          // const newContent = content + "\n" + `A: ${agreedDeleteLabel}` + '\n' +
          //   'Info: Die Anforderung ist abgestimmt'
          // await setzeSpezifikationsInhalt(ui, freshSpecTitle, newContent);

          // await uebernehmeIdee(ui, preparationIdeaTitle);



          //++++++++++++++
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

        })


      await test.step('Vorbereitung: Ideen-Referenz-Anker setzen', async () => {
        demoRun.narrate(
          'Willkommen zur Demonstration des Plaintext-Editors im Anforderungsviewer. Änderungen müssen immer im Rahmen einer Idee erfasst werden. Daher legen wir im ersten Schritt eine neue Idee an und setzen sie als Referenz-Anker.'
          )

        await ui.action('app-header-main-tab-Ideen')
        await ui.ensure('app-header-toggle-right-button')
        await ui.action('idee-page-create-button')
        await ui.fill('idee-view-title-input', case1IdeaTitle)
        await ui.action('idee-view-save-button')
        await ui.action('idee-view-side-set-planungsanker-button')


      });

      demoRun.narrate(
        'Nun betrachten wir die Möglichen Anwendungsfälle zur Änderungen von Anforderungen im Plaintext-Editor.',
      )

      await test.step('Fall 1: Erstellen einer neuen Anforderung',
        async () => {

          demoRun.stepTitle('Fall 1: Erstellen einer neuen Anforderung')

          demoRun.narrate(
            'Fall eins im Umgang mit dem Plaintext-Editor zeigt die Erfassung neuer Anforderungen.'
          )


          await ui.action('app-header-main-tab-Anforderungen')

          demoRun.narrate(
            "Hier öffnen wir im ersten Schritt die zu erweiternde Spezifikation.")

          await ui.action('anforderungsviewer-left-tab-spezifikationen')

          await ensureSpezifikationListModeTable()

          await ui.ensure('spezifikation-filter-toggle-button')

          await ui.fill('spezifikation-filter-search-input', sourceSpecTitle)

          await ui.action('spezifikation-filter-apply-button')

          await ui.clickRow('anforderungsviewer-spezifikationen-tableview', 1)

          demoRun.narrate(
            'Wir erfassen eine neue Anforderung. Demnach hat diese natürlich noch keine Anforderungsidentifikationsnummer. Daher beginnt die Zeile mit dem Präfix A Doppelpunkt. Das Regelwerk des Plaintext-Editors erkennt dies und interpretiert die Zeile als neue Anforderung, die angelegt werden soll.'
          )



          await ui.ensure('anforderungsviewer-toggle-plaintext-button')

          const inhalt1 = '\n' + `A: ${case1Label}` + '\n' +
            'Geschäftsregeln: Nur Sonntags erlaubt' + '\n' +
            'Info: weitere Informationen' + '\n' +
            'Klärungsbedarf: Klärungsbedarf hier';

          await ui.append('anforderungsviewer-plaintext-editor-content', inhalt1)

          demoRun.narrate(
            'Zusätzlich zu der Anforderung können Geschäftsregeln, Infos oder Klärungsbedarfe erfasst werden.'
          )


          const inhalt2 = '\n' + `A: ${case1Label}` + '\n' +
            'G: Nur Montags erlaubt mit dem Shortcut für Geschäftsregeln'

          await ui.append('anforderungsviewer-plaintext-editor-content', inhalt2)
          demoRun.narrate(
            'Der Plus-Marker an der Zeilennummer macht sofort sichtbar, dass hier eine neue Anforderung geplant ist.'
          )


          await ui.action('anforderungsviewer-save-plaintext-button')

          demoRun.narrate(
            'Der Speicherdialog zeigt eine Zusammenfassung der erkannten Änderungen. Dieser zeigt neben der jeweiligen Anzahlen auch im Rahmen welcher Idee die Änderungsvorschläge verortet werden.'
          )




          await ui.action('app-confirm-ok-button', {
            outcome: 'saved'
          })





          demoRun.narrate(
            'Die  so geplanten Änderungen können nun auch in der Idee eingesehen werden.',
          )

          await ui.action('anforderungsviewer-planungsanker-link-button')


        })

      await test.step('Fall 2: Abgestimmte Anforderung löschen',
        async () => {

          demoRun.stepTitle('Fall 2: Abgestimmte Anforderung löschen')


          demoRun.narrate(
            'Fall zwei im Umgang mit dem Plaintext-Editor demonstriert die geplante Obsoleszenz einer bereits abgestimmten Anforderung.'
          )
          demoRun.narrate(
            'Da eine solche Anforderung abgestimmt ist, kann man sie nicht sofort Löschen, sondern muss entsprechendes im Rahmen einer Idee vorschlagen. Dazu kann man die jeweilge Anforderung einfach aus dem Editor entfernen. Das Regelwerk erkennt, dass es sich um eine zuvor abgestimmte Anforderung handelt, und interpretiert die Änderung als geplante Obsoleszenz.'
          )


          await ui.action('app-header-main-tab-Anforderungen')

          let content = await ui.read('anforderungsviewer-plaintext-editor-content')
          const updatedContent = content.replace(new RegExp(
            `^.*${agreedObsoleteLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\r?\\n?`,
            'm'), '')
          await ui.fill('anforderungsviewer-plaintext-editor-content', updatedContent)


          await ui.action('anforderungsviewer-save-plaintext-button')

          await ui.action('app-confirm-ok-button')



          demoRun.narrate(
            'Nach dem Speichern der Änderungen taucht die Anforderung wieder auf. Jedoch trägt sie nun die Markierung, dass sie als obsolet geplant ist.'
          )




          await ui.action('anforderungsviewer-planungsanker-link-button')

          demoRun.narrate(
            'Die geplante Obsoleszenz wird nun in der Idee sichtbar.'
          )


        })


      await test.step(
        'Fall 3: nicht abgestimmte Anforderung verschwindet ohne Planungseintrag',
        async () => {

          demoRun.stepTitle('Fall 3: Nicht abgestimmte Anforderung löschen')


          demoRun.narrate(
            'Anders als die vorherigen Fälle wird die Löschung einer noch nicht abgestimmten Anforderung ohne nachvollziehbare Spuren umgesetzt.'
          )



          await ui.action('app-header-main-tab-Anforderungen')

          let nichtAbegestimmteAnforderungInhalt = "Nicht abgestimmte Anforderung";
          const inhalt1 = '\n'+`A: ${nichtAbegestimmteAnforderungInhalt}`;

          await ui.append('anforderungsviewer-plaintext-editor-content', inhalt1)

          demoRun.narrate(
            'Wir legen nun eine Anforderung an. Damit ist sie nicht abgestimmt..'
          )

          await ui.action('anforderungsviewer-save-plaintext-button')

          await ui.action('app-confirm-ok-button')

          demoRun.narrate(
            ' Und dann entfernen wir sie wieder. Da die Anforderung nicht abgestimmt war, wird sie ohne jegliche Dokumentationen gelöscht.'
          )


          //Nun wieder löschen
          let content = await ui.read('anforderungsviewer-plaintext-editor-content')
          const updatedContent = content.replace(new RegExp(
            `^.*${nichtAbegestimmteAnforderungInhalt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\r?\\n?`,
            'm'), '')
          await ui.fill('anforderungsviewer-plaintext-editor-content', updatedContent)


          await ui.action('anforderungsviewer-save-plaintext-button')

          await ui.action('app-confirm-ok-button')


          await ui.action('anforderungsviewer-planungsanker-link-button')





          demoRun.narrate(
            'Der Blick in die Idee zeigt, dass die erstellte und gelöschte Anforderung nicht weiter dokumentiert ist.',
          )


        })



      await test.step(
        'Fall 4: abgestimmte Token-ID in anderer Spezifikation wird als Move erkannt',
        async () => {

          demoRun.narrate(
            'Neben der Erstellung und Löschung von Anforderungen können diese auch in andere Spezifikaton einsortiert werden, ohne dabei erfasste Status zu verlieren. Dazu muss man nur die jeweilige Anfordeurngsidentifikationsnummer kennen und die anvisierte Spezifikation öffnen.'

          )


          //Zuerst öffnen wir die Quellspezifikation um eine Anforderung aussuchen, die umziehen soll
          await ui.action('app-header-main-tab-Anforderungen')

          let content = await ui.read('anforderungsviewer-plaintext-editor-content')
          const lineToMove = extractLineBySubstring(content, agreedMoveLabel)

          //Dort kopieren wir die komplette Anfoderung inklusive Anforderungsidentifikationsnummer in den Zwischenspeicher. Die Quellspezifikation muss nicht weiter bearbeitet werden.

          //Stattdessen öffnen wir nun die Zielspezifikation.

          await ui.action('anforderungsviewer-left-tab-spezifikationen')
          await ensureSpezifikationListModeTable()
          await ui.ensure('spezifikation-filter-toggle-button')
          await ui.fill('spezifikation-filter-search-input', targetSpecTitle)
          await ui.clickRow('anforderungsviewer-spezifikationen-tableview', 1)

          demoRun.narrate(
            'In der anvisierten Spezifikation fügen wir die Anforderung nun ein.'

          )


          //Dort kopieren wir die Anforderung inklusive Anforderungsidentifikationsnummer aus dem Zwischenspeicher hinein.

          await ui.append('anforderungsviewer-plaintext-editor-content', "\n" +
            lineToMove)

          //Bereits vor dem Speichern wird durch das Download-Symbol in der Zeilennummer sichtbar, dass ein Umzug erkannt wurde.


          await ui.action('anforderungsviewer-save-plaintext-button')



          await ui.action('app-confirm-ok-button')

          demoRun.narrate(
            'Der Editor erkennt diesen geplanten Umzug. Dieser wird in der Zeilennummer mittels des Download-Pfeils dargestellt.'
          )


          //Nach dem Speichern wird der Umzug auch in der Idee sichtbar.

          await ui.action('anforderungsviewer-planungsanker-link-button')


        })


      //BIS HIER STABIL 

      /**
       * Vorraussetzungen:
       * - Idee ist gesetzt
       * - Quellspezifikation existiert: ${sourceSpecTitle}
       * - Zielspezifikation existiert: ${targetSpecTitle}
       * - Quellspezifikation enthält die abgestimte Anforderung mit eindeutigem Inhalt: ${agreedMoveLabel2}
       */
      // await test.step(
      //   'Fall 5: abgestimmte aber geplant obsolete Token-ID in anderer Spezifikation wird als Move erkannt',
      //   async () => {

      //     demoRun.narrate(
      //       'Fall fünf zeigt den Umzug einer abgestimmten Anforderung in eine andere Spezifikation, die zuvor bereits als geplant obsolet gesetzt wurde.'
      //     )
      //     demoRun.narrate(
      //       'Hierzu kann tragen wir eine bestehende Anforderungsidentifikationsnummer in der anvisierten Spezifikation erneut ein, obwohl diese im vorigen Schritt bereits als geplant obsolet gesetzt wurde.'
      //     )
      //     demoRun.narrate(
      //       'Der Editor erkennt diesen geplanten Umzug. Dieser wird in der Zeilennummer mittels des Download-Pfeils dargestellt.'
      //     )


      //     //Zuerst öffnen wir die Quellspezifikation um eine Anforderung aussuchen, die umziehen soll
      //     await ui.action('app-header-main-tab-Anforderungen')

      //     //Quellspezifikation öffnen
      //     await ui.action('anforderungsviewer-left-tab-spezifikationen')
      //     await ensureSpezifikationListModeTable()
      //     await ui.ensure('spezifikation-filter-toggle-button')
      //     await ui.fill('spezifikation-filter-search-input', sourceSpecTitle)
      //     await ui.clickRow('anforderungsviewer-spezifikationen-tableview', 1)


      //     let content = await ui.read('anforderungsviewer-plaintext-editor-content')
      //     const lineToMove = extractLineBySubstring(content, agreedMoveLabel2)


      //     const updatedContent = content.replace(new RegExp(
      //       `^.*${agreedMoveLabel2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\r?\\n?`,
      //       'm'), '')
      //     await ui.fill('anforderungsviewer-plaintext-editor-content', updatedContent)


      //     await ui.action('anforderungsviewer-save-plaintext-button')

      //     await ui.action('app-confirm-ok-button')



      //     //Narrate: Dort kopieren wir die komplette Anfoderung inklusive Anforderungsidentifikationsnummer in den Zwischenspeicher. Die Quellspezifikation muss nicht weiter bearbeitet werden.

      //     //Narrate: Stattdessen öffnen wir nun die Zielspezifikation.

      //     //Zielspezifikation öffnen
      //     await ui.fill('spezifikation-filter-search-input', targetSpecTitle)
      //     await ui.clickRow('anforderungsviewer-spezifikationen-tableview', 1)

      //     //Narrate: Dort kopieren wir die Anforderung inklusive Anforderungsidentifikationsnummer aus dem Zwischenspeicher hinein.

      //     await ui.append('anforderungsviewer-plaintext-editor-content', "\n" +
      //       lineToMove)

      //     //Narrate: Bereits vor dem Speichern wird durch das Download-Symbol in der Zeilennummer sichtbar, dass ein Umzug erkannt wurde.


      //     await ui.action('anforderungsviewer-save-plaintext-button')

      //     await ui.action('app-confirm-ok-button')

      //     //Narrate:Nach dem Speichern wird der Umzug auch in der Idee sichtbar.

      //     await ui.action('anforderungsviewer-planungsanker-link-button')


      //   })


      // await test.step(
      //   'Fall 8: nicht abgestimmte Token-ID wird im Ziel erneut als Plus interpretiert',
      //   async () => {
      //     
      //     demoRun.narrate({
      //       id: 'narration-case8',
      //       text: [
      //         'Fall acht zeigt die gleiche Token-Wiederverwendung fuer eine noch nicht abgestimmte Anforderung.',
      //         'Diesmal entsteht bewusst kein Move.',
      //         'Die Zielseite bekommt stattdessen wieder einen Plus-Eintrag wie bei einer Neuanlage.'
      //       ].join(' '),
      //       voice: 'de-DE-Neural2-B'
      //     })

      //     await erstelleIdeeUndSetzeReferenz(ui, case8IdeaTitle)
      //     await openSpecInPlainText(draftSourceSpecTitle)
      //     await appendEditorLines([`A: ${case8SourceLabel}`])
      //     await savePlaintext()

      //     const case8Token = await getPersistedRequirementTokenByText(
      //       case8SourceLabel)

      //     await openIdeaSummary(case8IdeaTitle)
      //     await expectSummaryCountsForSpec(draftSourceSpecTitle, {
      //       plus: 1,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 0,
      //     })

      //     await openSpecInPlainText(draftTargetSpecTitle)
      //     await appendEditorLines([
      //       `${case8Token}: ${case8TargetLabel}`,
      //     ])
      //     await savePlaintext()
      //     await expectPlaintextLineNumberMarkerForLine({
      //       lineSubstring: [case8TargetLabel, case8SourceLabel],
      //       expectedMarker: '+',
      //     })

      //     await openIdeaSummary(case8IdeaTitle)
      //     await expectSummaryCountsForSpec(draftTargetSpecTitle, {
      //       plus: 1,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 0,
      //     })
      //     await expectSummaryCountsForSpec(draftSourceSpecTitle, {
      //       plus: 0,
      //       minus: 0,
      //       movePlus: 0,
      //       moveMinus: 0,
      //     })

      //     
      //   })

      // await test.step(
      //   'Fall 5: unbekannte globale ID fuehrt beim Speichern zu einem Fehler',
      // async () => {
      //       
      //       demoRun.narrate({
      //         id: 'narration-case5',
      //         text: [
      //           'Zum Abschluss zeigen wir noch den Fehlerfall.',
      //           'Wir geben eine Anforderungsidentifikationsnummer ein, die bislang nicht existiert.',
      //           'Beim Speichern erscheint eine Fehlermeldung, dass die Anforderung nicht existiert.'
      //         ].join(' '),
      //         voice: 'de-DE-Neural2-B'
      //       })

      //       await erstelleIdeeUndSetzeReferenz(ui, case5IdeaTitle)
      //       await openSpecInPlainText(errorSpecTitle)
      //       await appendEditorLines([
      //         `A-99999999: ${case5UnknownLabel}`,
      //       ])

      //       await runActionAndExpectFeedback(
      //         page,
      //         async () => {
      //           const dialogOpened = await expectPlaintextSaveDialogStatsAndConfirm([
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

      //       
      //     })
    } finally {
      
      await demoRun.finish({
        runId
      })
    }
  })
})
