export const requirementInteractions = [
  {
    trigger: 'anforderung-filter-quick-reviewrun-button',
    verb: 'action',
    defaultOutcome: 'cleared',
    outcomes: {
      cleared: {
        target: 'anforderungsviewer-local-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'anforderung-filter-active-reviewrun-button',
    verb: 'action',
    defaultOutcome: 'cleared',
    outcomes: {
      cleared: {
        target: 'anforderungsviewer-local-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'app-header-main-tab-Anforderungen',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-local-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'anforderungsviewer-left-tab-spezifikationen',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-spezifikationen-tableview',
        visible: true,
        state: 'loaded',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-reload-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-reload-button',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-spezifikationen-create-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-add-dialog',
        visible: true,
        state: 'open',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-toggle-plaintext-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-toggle-plaintext-button',
    verb: 'ensure',
    desiredState: 'on',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-planungsanker-link-button',
    verb: 'action',
    defaultOutcome: 'success',
    outcomes: {
      success: {
        target: 'idee-view-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'anforderungsviewer-spezifikationen-tableview',
    verb: 'clickRow',
    defaultOutcome: 'ready',
    rowTargetPrefix: 'spezifikation-listview-row-',
    outcomes: {
      clicked: {
        targetFromParam: 'rowTestId',
        visible: true,
      },
	  //Spezifikation muss geladen sein
      ready: {
        target: 'anforderungsviewer-reload-button',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-export-accordion-toggle-button',
    verb: 'action',
    defaultOutcome: 'opened',
    outcomes: {
      opened: {
        target: 'spezifikation-export-accordion-toggle-button',
        visible: true,
        state: 'open',
      },
      ready: {
        target: 'spezifikation-export-accordion-content-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-export-create-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-create-dialog',
        visible: true,
        state: 'open',
      },
    },
  },
  {
    trigger: 'spezifikation-export-create-confirm-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-list-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-export-create-include-unconfirmed-toggle',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-create-dialog',
        visible: true,
        state: 'open',
      },
    },
  },
  {
    trigger: 'spezifikation-export-create-title-input',
    verb: 'fill',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-create-dialog',
        visible: true,
        state: 'open',
      },
    },
  },
  {
    trigger: 'spezifikation-export-create-parent-pageid-input',
    verb: 'fill',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-create-dialog',
        visible: true,
        state: 'open',
      },
    },
  },
  {
    trigger: 'spezifikation-export-delete-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-list-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-export-run-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-list-container',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-export-open-confluence-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-export-list-container',
        visible: true,
      },
    },
  }
]

export const requirementPlaintextEditorSaveDialogInteractions = [
  {
    trigger: 'anforderungsviewer-save-plaintext-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'app-confirm-dialog',
        visible: true,
        text: 'Plaintext speichern',
      },
      success: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
    },
  },
  {
    trigger: 'app-confirm-cancel-button',
    verb: 'action',
    defaultOutcome: 'dialogClosed',
    outcomes: {
      dialogClosed: {
        target: 'app-confirm-dialog',
        visible: false,
      },
    },
  },
  {
    trigger: 'app-confirm-ok-button',
    verb: 'action',
    defaultOutcome: 'dialogClosed',
    outcomes: {
      dialogClosed: {
        target: 'app-confirm-dialog',
        visible: false,
      },
      saved: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
      discarded: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
    },
  },
]

export const requirementPlaintextEditorInteractions = [
  {
    trigger: 'anforderungsviewer-plaintext-editor-content',
    verb: 'clickSpecHeading',
    defaultOutcome: 'openedSpecTab',
    outcomes: {
      openedSpecTab: {
        target: 'anforderungsviewer-right-tab-spezifikationen',
        visible: true,
        state: 'active',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-plaintext-conflict-ok-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-plaintext-conflict-dialog',
        visible: false,
      },
    },
  },
  {
    trigger: 'anforderungsviewer-plaintext-editor-content',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-plaintext-editor-content',
    verb: 'fill',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
      valueUpdated: {
        target: 'anforderungsviewer-plaintext-editor-content',
        textFromParam: 'value',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-plaintext-editor-content',
    verb: 'append',
    defaultOutcome: 'valueAppended',
    outcomes: {
      valueAppended: {
        target: 'anforderungsviewer-plaintext-editor-content',
        textFromParam: 'value',
      },
      ready: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-plaintext-editor-content',
    verb: 'read',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
    },
  },
  {
    trigger: 'anforderungsviewer-plaintext-editor-content',
    verb: 'clickByText',
    defaultOutcome: 'clicked',
    outcomes: {
      clicked: {
        target: 'anforderungsviewer-plaintext-render-state',
        visible: true,
        state: 'ready',
      },
      hoverOpenVisible: {
        target: 'anforderungsviewer-plaintext-reference-hover-open-button',
        visible: true,
      },
    },
  },
]

export const spezifikationFilterInteractions = [
  {
    trigger: 'spezifikation-filter-toggle-button',
    verb: 'action',
    defaultOutcome: 'opened',
    outcomes: {
      opened: {
        target: 'spezifikation-filter-toggle-button',
        visible: true,
        state: 'open',
      },
      closed: {
        target: 'spezifikation-filter-toggle-button',
        visible: true,
        state: 'closed',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-toggle-button',
    verb: 'ensure',
    desiredState: 'open',
    defaultOutcome: 'opened',
    outcomes: {
      opened: {
        target: 'spezifikation-filter-toggle-button',
        visible: true,
        state: 'open',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-search-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'spezifikation-filter-search-input',
        valueFromParam: 'value',
      },
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-typ-select',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-typ-select',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-default-view-select',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-default-view-select',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-swimlane-select',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-swimlane-select',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-unassigned-select',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-unassigned-select',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-deleted-select',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-deleted-select',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-lebenszyklus-select',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-lebenszyklus-select',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-reference-field',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-reference-dialog',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-reference-clear-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-reference-dialog',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-reference-cancel-button',
    verb: 'action',
    defaultOutcome: 'dialogClosed',
    outcomes: {
      dialogClosed: {
        target: 'spezifikation-filter-reference-dialog',
        visible: false,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-reference-apply-button',
    verb: 'action',
    defaultOutcome: 'dialogClosed',
    outcomes: {
      dialogClosed: {
        target: 'spezifikation-filter-reference-dialog',
        visible: false,
      },
    },
  },
  {
    trigger: 'spezifikation-filter-apply-button',
    verb: 'action',
    defaultOutcome: 'filtered',
    outcomes: {
      filtered: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-reset-button',
    verb: 'action',
    defaultOutcome: 'reset',
    outcomes: {
      reset: {
        target: 'anforderungsviewer-spezifikationen-tableview',
        visible: true,
        state: 'loaded',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-search-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-status-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-typ-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-default-view-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-swimlane-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-unassigned-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-deleted-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-lebenszyklus-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
  {
    trigger: 'spezifikation-filter-clear-reference-button',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-filter-container',
        visible: true,
        state: 'idle',
      },
    },
  },
]

export const spezifikationAddDialogInteractions = [
  {
    trigger: 'spezifikation-form-pageid-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'spezifikation-form-pageid-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'spezifikation-form-title-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'spezifikation-form-title-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'spezifikation-form-typ-select',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-form-typ-select',
        visible: true,
      },
      querschnittSelected: {
        target: 'spezifikation-form-querschnitt-input',
        visible: true,
      },
      cleared: {
        target: 'spezifikation-form-querschnitt-input',
        visible: false,
      },
    },
  },
  {
    trigger: 'spezifikation-form-querschnitt-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'spezifikation-form-querschnitt-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'spezifikation-form-referenzmodell-field',
    verb: 'action',
    defaultOutcome: 'ready',
    outcomes: {
      ready: {
        target: 'spezifikation-form-referenzmodell-dialog',
        visible: true,
      },
    },
  },
  {
    trigger: 'spezifikation-form-referenzmodell-cancel-button',
    verb: 'action',
    defaultOutcome: 'dialogClosed',
    outcomes: {
      dialogClosed: {
        target: 'spezifikation-form-referenzmodell-dialog',
        visible: false,
      },
    },
  },
  {
    trigger: 'spezifikation-form-referenzmodell-confirm-button',
    verb: 'action',
    defaultOutcome: 'dialogClosed',
    outcomes: {
      dialogClosed: {
        target: 'spezifikation-form-referenzmodell-dialog',
        visible: false,
      },
    },
  },
  {
    trigger: 'spezifikation-form-info-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'spezifikation-form-info-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'spezifikation-form-wip-input',
    verb: 'fill',
    defaultOutcome: 'valueUpdated',
    outcomes: {
      valueUpdated: {
        target: 'spezifikation-form-wip-input',
        valueFromParam: 'value',
      },
    },
  },
  {
    trigger: 'spezifikation-add-cancel-button',
    verb: 'action',
    defaultOutcome: 'dialogClosed',
    outcomes: {
      dialogClosed: {
        target: 'spezifikation-add-dialog',
        visible: false,
      },
    },
  },
  {
    trigger: 'spezifikation-add-save-button',
    verb: 'action',
    defaultOutcome: 'success',
    outcomes: {
      success: {
        target: 'spezifikation-add-dialog',
        visible: false,
        successNotificationSinceAction: true,
      },
    },
  },
]


