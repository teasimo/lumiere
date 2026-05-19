import {
  test,
} from '@playwright/test'

import {
  ROOT_URL,
  extractLineBySubstring,
  buildRunId,
  createUiTestApi,
} from './support/test-helper.js'




test.describe('Neue Interactionslogik', () => {
  test(
    'legt Idee und Spezifikation an, erfasst Anforderungen per Plaintext und setzt die Idee um',
    async ({
      page
    }, testInfo) => {
      const runId = `${buildRunId(testInfo)}-flow`
      const ideaTitleA = `Demo-Idee A ${runId}`
      const specTitleA = `Demo-Spezifikation A ${runId}`
      const specTitleB = `Demo-Spezifikation B ${runId}`
      const ideaTitleB = `Demo-Idee B ${runId}`


      const ui = createUiTestApi(page, {
        demo: true
      })

      try {

        await test.step('Einloggen', async () => {
          await page.goto(`${ROOT_URL}/login`, {
            waitUntil: 'networkidle'
          })

          //Login
          await ui.fill('login-username-input', 'Schulte')
          await ui.fill('login-password-input', 'test')
          await ui.action('login-submit-button')
        })

        await test.step('Spezifikation A : Anforderung erstellen und umsetzen',
          async () => {


            //Idee erstellen und Planungsanker setzen
            await ui.action('app-header-main-tab-Ideen')
            await ui.ensure('app-header-toggle-right-button')
            await ui.action('idee-page-create-button')
            await ui.fill('idee-view-title-input', ideaTitleA)
            await ui.action('idee-view-save-button')
            await ui.action('idee-view-side-set-planungsanker-button')

            //Spezifikation A anlegen
            await ui.action('app-header-main-tab-Anforderungen')
            await ui.action('anforderungsviewer-left-tab-spezifikationen')
            await ui.action('anforderungsviewer-spezifikationen-create-button')

            await ui.fill('spezifikation-form-title-input', specTitleA)
            await ui.action('spezifikation-add-save-button')

            //Anforderungen per Plaintext erfassen
            await ui.action('anforderungsviewer-toggle-plaintext-button')

            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nA: Erste Anforderung')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nGeschäftsregeln: Geschäftsregel der ersten Anforderung')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nA: Zweite Anforderung')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nKlärungsbedarf: Klärungsbedarf der zweiten Anforderung')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nA: Dritte Anforderung')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nInfo: Info der dritten Anforderung')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nA: Vierte Anforderung')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nG: Geschäftsregel mit Shortcut')
            await ui.append('anforderungsviewer-plaintext-editor-content',
              '\nA: Fünte Anforderung')

            // speichern
            await ui.action('anforderungsviewer-save-plaintext-button')
            await ui.action('app-confirm-ok-button', { outcome: 'saved' })

            //Idee über Anker öffnen, annehmen und Änderungen umsetzen
            await ui.action('anforderungsviewer-planungsanker-link-button')
            await ui.ensure('app-header-toggle-right-button')
            await ui.action('idee-view-status-angenommen-node')

            await ui.action('idee-view-apply-requirement-statuses-button')

            await ui.action('idee-view-requirement-statuses-confirm-ok-button')

          })

          await test.step('Idee B erstellen und Planungsanker setzen',
          async () => {
              //Idee B erstellen und Planungsanker setzen
            await ui.action('app-header-main-tab-Ideen')
            await ui.ensure('app-header-toggle-right-button')
            await ui.action('idee-page-create-button')
            await ui.fill('idee-view-title-input', ideaTitleB)
            await ui.action('idee-view-save-button')
            await ui.action('idee-view-side-set-planungsanker-button')

          });
        
        await test.step('Anforderung in Spezifikation B im Rahmen eines Umzugs einfügen',
          async () => {


          

            //Spezifikation A öffnen und aktualisieren
            await ui.action('app-header-main-tab-Anforderungen')
            await ui.action('anforderungsviewer-reload-button')

            //Plaintext-Inhalt von Spezifikation A lesen und erste Anforderungszeile merken
            const plaintextContentSpecA = await ui.read(
              'anforderungsviewer-plaintext-editor-content')
            const firstRequirementLineSpecA = extractLineBySubstring(
              plaintextContentSpecA,
              'Erste Anforderung')

            //Spezifikation B anlegen
            await ui.action('anforderungsviewer-left-tab-spezifikationen')
            await ui.action('anforderungsviewer-spezifikationen-create-button')

            await ui.fill('spezifikation-form-title-input', specTitleB)
            await ui.action('spezifikation-add-save-button')

            //Umzug von Anforderungen / einfügen
            await ui.append('anforderungsviewer-plaintext-editor-content', "\n" +
              firstRequirementLineSpecA)

            await ui.action('anforderungsviewer-save-plaintext-button')

            await ui.action('app-confirm-ok-button', { outcome: 'saved' })




          });

        await test.step(
          'Umgezogene Anforderungen in Spezifikation B ändern',
          async () => {

            //Änderungen der umgezogenen Anforderungen
            const plaintextContentB = await ui.read(
              'anforderungsviewer-plaintext-editor-content')

            const originalLine = extractLineBySubstring(plaintextContentB,
              'Erste Anforderung')
            const modifiedLine = originalLine.replace('Erste',
              '1. Anforderung aber geänderte während eines Umzugs')
            const plaintextContentBModified = plaintextContentB.replace(originalLine,
              modifiedLine)

            //achtung, fill ist hier append!?
            await ui.fill('anforderungsviewer-plaintext-editor-content',
              plaintextContentBModified)

            //speichern
            await ui.action('anforderungsviewer-save-plaintext-button')
            await ui.action('app-confirm-ok-button', { outcome: 'saved' })

            //unnötiger  ? reload
            await ui.action('anforderungsviewer-reload-button')


          })


      } finally {

      }
    })
})
