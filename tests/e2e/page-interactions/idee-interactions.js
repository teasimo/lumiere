export const ideeInteractions = [
	{
		trigger: 'app-header-main-tab-Ideen',
		verb: 'action',
		defaultOutcome: 'ready',
		outcomes: {
			ready: {
				target: 'idee-page-create-button',
				visible: true,
			},
		},
	},
	{
		trigger: 'app-header-toggle-right-button',
		verb: 'ensure',
		desiredState: 'open',
		defaultOutcome: 'ready',
		outcomes: {
			ready: {
				target: 'app-header-toggle-right-button',
				visible: true,
				state: 'open',
			},
		},
	},
	{
		trigger: 'idee-page-create-button',
		verb: 'action',
		defaultOutcome: 'ready',
		outcomes: {
			ready: {
				target: 'idee-view-side-panel-container',
				visible: true,
			},
			editReady: {
				target: 'idee-view-title-input',
				visible: true,
			},
		},
	},
]

export const ideeViewInteractions = [
	{
		trigger: 'idee-view-title-input',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-view-title-input',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-view-description-editor',
		verb: 'append',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-view-description-editor',
				textFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-view-decision-note-editor',
		verb: 'append',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-view-decision-note-editor',
				textFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-view-save-button',
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
		trigger: 'idee-view-cancel-button',
		verb: 'action',
		defaultOutcome: 'cancelled',
		outcomes: {
			cancelled: {
				target: 'idee-view-container',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-view-side-edit-button',
		verb: 'action',
		defaultOutcome: 'ready',
		outcomes: {
			ready: {
				target: 'idee-view-title-input',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-view-open-requirement-viewer-button',
		verb: 'action',
		defaultOutcome: 'success',
		outcomes: {
			success: {
				target: 'anforderungsviewer-local-container',
				visible: true,
			},
		},
	},
]

export const ideeReferenceAnchorInteractions = [
	{
		trigger: 'idee-view-side-set-planungsanker-button',
		verb: 'action',
		defaultOutcome: 'success',
		outcomes: {
			success: {
				target: 'idee-view-planungsanker-link-button',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-view-planungsanker-link-button',
		verb: 'action',
		defaultOutcome: 'success',
		outcomes: {
			success: {
				target: 'anforderungsviewer-local-container',
				visible: true,
			},
		},
	},
]

export const ideeStatusInteractions = [
	{
		trigger: 'idee-view-status-angenommen-node',
		verb: 'action',
		defaultOutcome: 'angenommen',
		outcomes: {
			angenommen: {
				target: 'idee-view-status-angenommen-node',
				visible: true,
				state: 'active',
			},
		},
	},
	{
		trigger: 'idee-view-apply-requirement-statuses-button',
		verb: 'action',
		defaultOutcome: 'triggered',
		outcomes: {
			triggered: {
				target: 'idee-view-requirement-statuses-confirm-ok-button',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-view-requirement-statuses-confirm-ok-button',
		verb: 'action',
		defaultOutcome: 'implemented',
		outcomes: {
			implemented: {
				target: 'idee-view-status-umgesetzt-node',
				visible: true,
				state: 'active',
				successNotification: true,
			},
		},
	},
]

export const ideeAiReviewInteractions = [
	{
		trigger: 'idee-ai-review-accordion-toggle',
		verb: 'action',
		defaultOutcome: 'expanded',
		outcomes: {
			expanded: {
				target: 'idee-ai-review-accordion-toggle',
				visible: true,
				state: 'expanded',
			},
		},
	},
	{
		trigger: 'idee-ai-review-open-details-link-button',
		verb: 'action',
		defaultOutcome: 'opened',
		outcomes: {
			opened: {
				target: 'idee-ai-review-details-dialog',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-ai-review-runs-open-details-button',
		verb: 'action',
		defaultOutcome: 'opened',
		outcomes: {
			opened: {
				target: 'idee-ai-review-details-dialog',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-ai-review-details-copy-full-payload-button',
		verb: 'action',
		defaultOutcome: 'copied',
		outcomes: {
			copied: {
				target: 'idee-ai-review-details-full-payload-panel',
				visible: true,
				state: 'expanded',
				successNotification: true,
			},
		},
	},
	{
		trigger: 'idee-ai-review-details-copy-raw-response-button',
		verb: 'action',
		defaultOutcome: 'copied',
		outcomes: {
			copied: {
				target: 'idee-ai-review-details-raw-response-panel',
				visible: true,
				state: 'expanded',
				successNotification: true,
			},
		},
	},
	{
		trigger: 'idee-ai-review-runs-open-anforderungen-button',
		verb: 'action',
		defaultOutcome: 'opened',
		outcomes: {
			opened: {
				target: 'anforderungsviewer-local-container',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-view-side-start-ai-review-button',
		verb: 'action',
		defaultOutcome: 'profileDialogOpen',
		outcomes: {
			profileDialogOpen: {
				target: 'ai-review-profile-select-confirm-button',
				visible: true,
			},
		},
	},
	{
		trigger: 'ai-review-profile-select-confirm-button',
		verb: 'action',
		defaultOutcome: 'started',
		outcomes: {
			started: {
				target: 'idee-ai-review-runs-list',
				visible: true,
			},
		},
	},
	{
		trigger: 'idee-ai-review-filter-status-select',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-ai-review-filter-status-select',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-ai-review-filter-severity-select',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-ai-review-filter-severity-select',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-ai-review-filter-type-select',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-ai-review-filter-type-select',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-ai-review-filter-requirement-select',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-ai-review-filter-requirement-select',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-ai-review-filter-spezifikation-select',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-ai-review-filter-spezifikation-select',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-ai-review-finding-status-select',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-ai-review-finding-status-select',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-ai-review-finding-status-note-input',
		verb: 'fill',
		defaultOutcome: 'valueUpdated',
		outcomes: {
			valueUpdated: {
				target: 'idee-ai-review-finding-status-note-input',
				valueFromParam: 'value',
			},
		},
	},
	{
		trigger: 'idee-ai-review-finding-save-status-button',
		verb: 'action',
		defaultOutcome: 'saved',
		outcomes: {
			saved: {
				target: 'idee-ai-review-findings-list',
				visible: true,
			},
		},
	},
]

export const spezifikationAiReviewInteractions = [
	{
		trigger: 'spezifikation-view-start-ai-review-button',
		verb: 'action',
		defaultOutcome: 'profileDialogOpen',
		outcomes: {
			profileDialogOpen: {
				target: 'ai-review-profile-select-confirm-button',
				visible: true,
			},
		},
	},
	{
		trigger: 'spezifikation-view-stats-accordion-toggle',
		verb: 'action',
		defaultOutcome: 'expanded',
		outcomes: {
			expanded: {
				target: 'spezifikation-view-stats-accordion-toggle',
				visible: true,
				state: 'expanded',
			},
		},
	},
	{
		trigger: 'spezifikation-ai-review-accordion-toggle',
		verb: 'action',
		defaultOutcome: 'expanded',
		outcomes: {
			expanded: {
				target: 'spezifikation-ai-review-accordion-toggle',
				visible: true,
				state: 'expanded',
			},
		},
	},
	{
		trigger: 'spezifikation-ai-review-details-copy-full-payload-button',
		verb: 'action',
		defaultOutcome: 'copied',
		outcomes: {
			copied: {
				target: 'spezifikation-ai-review-details-full-payload-panel',
				visible: true,
				state: 'expanded',
				successNotification: true,
			},
		},
	},
	{
		trigger: 'spezifikation-ai-review-details-copy-raw-response-button',
		verb: 'action',
		defaultOutcome: 'copied',
		outcomes: {
			copied: {
				target: 'spezifikation-ai-review-details-raw-response-panel',
				visible: true,
				state: 'expanded',
				successNotification: true,
			},
		},
	},
]
