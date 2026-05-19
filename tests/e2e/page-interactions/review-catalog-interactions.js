export const reviewCatalogInteractions = [
  {
    trigger: 'anfo-review-rule-create-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anfo-review-rule-title-input',
        visible: true,
      },
    },
  },
  {
    trigger: 'anfo-review-rule-save-button',
    verb: 'action',
    defaultOutcome: 'saved',
    outcomes: {
      saved: {
        target: 'anfo-review-rule-detail-container',
        visible: true,
        successNotification: true,
      },
    },
  },
  {
    trigger: 'anfo-review-profile-create-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anfo-review-profile-title-input',
        visible: true,
      },
    },
  },
  {
    trigger: 'anfo-review-profile-save-button',
    verb: 'action',
    defaultOutcome: 'saved',
    outcomes: {
      saved: {
        target: 'anfo-review-profile-detail-container',
        visible: true,
        successNotification: true,
      },
    },
  },
]
