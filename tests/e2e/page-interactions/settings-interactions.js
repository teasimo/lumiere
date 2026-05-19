export const settingsAiReviewInteractions = [
  {
    trigger: 'settings-ai-review-system-prompt-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'settings-ai-review-system-prompt-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'settings-ai-review-reload-button',
    verb: 'action',
    defaultOutcome: 'reloaded',
    outcomes: {
      reloaded: {
        target: 'settings-ai-review-page-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'settings-ai-review-save-button',
    verb: 'action',
    defaultOutcome: 'saved',
    outcomes: {
      saved: {
        target: 'settings-ai-review-page-container',
        visible: true,
      },
    },
  },
]
