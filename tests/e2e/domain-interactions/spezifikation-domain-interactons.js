export async function erstelleSpezifikation(ui, spezifikationTitel) {
  //Spezifikation A anlegen
  await ui.action('app-header-main-tab-Anforderungen')
  await ui.action('anforderungsviewer-left-tab-spezifikationen')
  await ui.action('anforderungsviewer-spezifikationen-create-button')

  await ui.fill('spezifikation-form-title-input', spezifikationTitel)
  await ui.action('spezifikation-add-save-button')
}

export async function oeffneSpezifikation(ui, spezifikationTitel) {
  await ui.action('app-header-main-tab-Anforderungen')

  await ui.action('anforderungsviewer-left-tab-spezifikationen')

  await ui.ensure('spezifikation-filter-toggle-button')

  await ui.fill('spezifikation-filter-search-input', spezifikationTitel)

  await ui.clickRow('anforderungsviewer-spezifikationen-tableview', 1)
}

export async function leseSpezifikationsInhalt(ui, spezifikationTitel) {

  await oeffneSpezifikation(ui, spezifikationTitel);

  await ui.ensure('anforderungsviewer-toggle-plaintext-button')

  return await ui.read('anforderungsviewer-plaintext-editor-content')
}

export async function setzeSpezifikationsInhalt(ui, spezifikationTitel, inhalt) {

  await oeffneSpezifikation(ui, spezifikationTitel);

  await ui.ensure('anforderungsviewer-toggle-plaintext-button')

  await ui.fill('anforderungsviewer-plaintext-editor-content', inhalt)

  await ui.action('anforderungsviewer-save-plaintext-button')
  await ui.action('app-confirm-ok-button', { outcome: 'saved' })


}

export async function legeSpezifikationExportAn(ui, spezifikationTitel, includeNichtAbgestimmt = true) {
  await oeffneSpezifikation(ui, spezifikationTitel)
  await ui.action('spezifikation-export-accordion-toggle-button', { outcome: 'ready' })
  await ui.action('spezifikation-export-create-button')
  if (includeNichtAbgestimmt === false) {
    await ui.action('spezifikation-export-create-include-unconfirmed-toggle')
  }
  await ui.action('spezifikation-export-create-confirm-button', { outcome: 'ready' })
}

export async function starteSpezifikationExport(ui, spezifikationTitel) {
  await oeffneSpezifikation(ui, spezifikationTitel)
  await ui.action('spezifikation-export-accordion-toggle-button', { outcome: 'ready' })
  await ui.action('spezifikation-export-run-button', { outcome: 'ready' })
}
