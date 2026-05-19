export const loginInteractions = [
  {
    trigger: 'login-username-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'login-username-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'login-password-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'login-password-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'login-submit-button',
    verb: 'action',
    defaultOutcome: 'success',
    outcomes: {
      success: {
        target: 'app-layout-container',
        visible: true,
      },
    },
  },
]
