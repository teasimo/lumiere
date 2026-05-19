//Voraussetzung: Eingeloggt
export async function erstelleIdeeUndSetzeReferenz(ui, ideaTitle) {
  //Idee erstellen und Planungsanker setzen
  await ui.action('app-header-main-tab-Ideen')
  await ui.ensure('app-header-toggle-right-button')
  await ui.action('idee-page-create-button')
  await ui.fill('idee-view-title-input', ideaTitle)
  await ui.action('idee-view-save-button')
  await ui.action('idee-view-side-set-planungsanker-button')
}

//Voraussetzung: Idee ist als Referenz gesetzt
export async function setzeIdeeAngenommenUndUebernehmeAnforderungsaenderungen(ui) {
  await ui.action('app-header-main-tab-Ideen')

  await ui.ensure('app-header-toggle-right-button')
  await ui.action('idee-view-status-angenommen-node')

  await ui.action('idee-view-apply-requirement-statuses-button')

  await ui.action('idee-view-requirement-statuses-confirm-ok-button')
}

// Voraussetzung: Idee ist geoeffnet
export async function starteKiReviewFuerIdee(ui) {
  await ui.action('idee-view-side-start-ai-review-button')
  await ui.action('idee-view-ai-review-start-confirm-ok-button')
}
