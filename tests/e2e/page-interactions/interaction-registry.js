import {
  ideeInteractions,
  ideeAiReviewInteractions,
  spezifikationAiReviewInteractions,
  ideeReferenceAnchorInteractions,
  ideeStatusInteractions,
  ideeViewInteractions,
} from './idee-interactions.js'
import { loginInteractions } from './login-interactions.js'
import {
  requirementInteractions,
  requirementPlaintextEditorInteractions,
  requirementPlaintextEditorSaveDialogInteractions,
  spezifikationAddDialogInteractions,
  spezifikationFilterInteractions,
} from './requirement-interactions.js'
import { anfoAutoInteractions } from './anfo-auto-interactions.js'
import { anfoButtonInteractions } from './anfo-button-interactions.js'
import { settingsAiReviewInteractions } from './settings-interactions.js'
import { reviewCatalogInteractions } from './review-catalog-interactions.js'

export const registeredInteractions = [
  ...loginInteractions,
  ...ideeInteractions,
  ...ideeAiReviewInteractions,
  ...spezifikationAiReviewInteractions,
  ...ideeViewInteractions,
  ...ideeReferenceAnchorInteractions,
  ...ideeStatusInteractions,
  ...requirementInteractions,
  ...requirementPlaintextEditorInteractions,
  ...requirementPlaintextEditorSaveDialogInteractions,
  ...spezifikationFilterInteractions,
  ...spezifikationAddDialogInteractions,
  ...anfoAutoInteractions,
  ...anfoButtonInteractions,
  ...settingsAiReviewInteractions,
  ...reviewCatalogInteractions,
]

const interactionsByVerbAndTrigger = new Map()

for (const interaction of registeredInteractions) {
  const key = `${interaction.verb}::${interaction.trigger}`
  if (interactionsByVerbAndTrigger.has(key)) {
    throw new Error(`Duplicate interaction registration for ${key}`)
  }
  interactionsByVerbAndTrigger.set(key, interaction)
}

export function getRegisteredInteraction(verb, trigger) {
  return interactionsByVerbAndTrigger.get(`${verb}::${trigger}`) ?? null
}