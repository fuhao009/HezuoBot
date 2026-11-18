export type FlowState = {
  surface: 'web' | 'native' | 'visual' | 'general';
  stage: 'prepare' | 'observe' | 'act' | 'verify' | 'blocked';
  operations: number;
  observations: number;
  verification: 'not_observed' | 'observation_available' | 'needs_observation';
  lastOperation?: string;
  recovery?: { code: string; next: 'observe' | 'prepare' | 'ask_user' | 'inspect' | 'wait' };
};

export type FlowEvent = { name: string; ok: boolean; code?: unknown; detail?: unknown; hasScreenshot: boolean };
type Tool = { surface: FlowState['surface']; stage: 'prepare' | 'observe' | 'act'; combined?: boolean };

const tools = new Map<string, Tool>();
function register(surface: Tool['surface'], stage: Tool['stage'], names: string, combined = false): void {
  for (const name of names.split(' ')) tools.set(name, { surface, stage, combined });
}
register('web', 'prepare', 'browser_viewport browser_switch');
register('web', 'observe', 'browser_tabs browser_read browser_observe browser_screenshot browser_dialogs browser_wait browser_wait_for');
register('web', 'act', 'browser_open browser_back browser_click browser_fill browser_scroll browser_dialog_accept browser_dialog_dismiss browser_session_save browser_session_clear');
register('native', 'prepare', 'desktop_launch desktop_focus_window');
register('native', 'prepare', 'desktop_list_apps desktop_list_windows');
register('native', 'observe', 'desktop_snapshot desktop_wait');
register('native', 'act', 'desktop_click desktop_set_value desktop_type desktop_press');
register('native', 'act', 'desktop_click_and_snapshot desktop_set_value_and_snapshot', true);
register('visual', 'observe', 'computer_status computer_window');
register('visual', 'prepare', 'computer_pause');
register('visual', 'act', 'computer_click computer_type computer_press_key computer_hotkey computer_scroll');
register('visual', 'act', 'computer_action_and_screenshot', true);
register('general', 'observe', 'sha256 current_time');
register('general', 'act', 'tgb_login_local');

const recovery: Record<string, NonNullable<FlowState['recovery']>['next']> = {
  'dialog-pending': 'ask_user', 'action-pending': 'wait', cancelled: 'observe', CANCELLED: 'observe',
  'observation-failed': 'observe', 'action-unconfirmed': 'observe', 'stale-ref': 'observe',
  covered: 'observe', 'not-visible': 'observe', unstable: 'wait', timeout: 'inspect', 'condition-timeout': 'inspect',
  disabled: 'inspect', 'not-editable': 'inspect', closed: 'prepare', navigation: 'inspect',
  'invalid-arguments': 'inspect', refused: 'ask_user', execution: 'inspect',
  'no-history': 'inspect', 'history-unconfirmed': 'observe', 'value-mismatch': 'observe',
  'http-error': 'inspect', 'navigation-unconfirmed': 'observe', COMPUTER_ERROR: 'inspect',
  STALE_REF: 'observe', STALE_REFERENCE: 'observe', ELEMENT_NOT_FOUND: 'observe', INVALID_REF: 'observe',
  UNKNOWN_REF: 'observe', REF_SCOPE_MISMATCH: 'observe', OBSERVATION_REQUIRED: 'observe', OBSERVATION_FAILED: 'observe',
  FOCUS_REQUIRED: 'prepare', NO_FOCUSED_ELEMENT: 'prepare', APP_NOT_RUNNING: 'prepare', WINDOW_NOT_FOUND: 'prepare',
  STARTUP_FAILED: 'prepare', AX_UNAVAILABLE: 'prepare', PERMISSION_DENIED: 'ask_user', PERMISSION_REQUIRED: 'ask_user',
  AX_NOT_TRUSTED: 'ask_user', ACTION_PENDING: 'wait', DIALOG_PENDING: 'wait', HTTP_ERROR: 'inspect',
  NAVIGATION_FAILED: 'inspect', NAVIGATION_UNCONFIRMED: 'inspect', PAGE_ERROR: 'inspect', AX_ACTION_FAILED: 'inspect',
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function initialFlow(): FlowState {
  return { surface: 'general', stage: 'prepare', operations: 0, observations: 0, verification: 'not_observed' };
}

export function advanceFlow(previous: FlowState, event: FlowEvent): FlowState {
  const tool = tools.get(event.name);
  // Unknown names are not copied into state: they may contain arbitrary input.
  if (!tool) return { ...previous, operations: previous.operations + 1, ...(previous.recovery ? { recovery: { ...previous.recovery } } : {}) };
  const detail = record(event.detail);
  const code = typeof event.code === 'string' && Object.hasOwn(recovery, event.code) ? event.code : undefined;
  const pending = code === 'dialog-pending' || code === 'action-pending' || code === 'DIALOG_PENDING' || code === 'ACTION_PENDING' || (tool.surface === 'web' && detail?.actionComplete === false && event.ok);
  const actionSucceeded = tool.combined && detail?.actionOk === true;
  const observationFailed = !!(tool.combined && actionSucceeded && (detail?.observationAttempted !== true || detail?.observationOk !== true)
    || tool.surface === 'web' && tool.stage === 'act' && detail?.observationComplete === false);
  const blocked = !event.ok || pending;
  const state = record(detail?.state);
  const pageStateAvailable = tool.surface === 'web' && event.name !== 'browser_wait' && state?.untrusted === true && detail?.observationComplete !== false;
  const combinationObserved = tool.combined && detail?.actionOk === true && detail?.observationAttempted === true && detail?.observationOk === true && (tool.surface !== 'visual' || event.hasScreenshot);
  const standaloneObserved = tool.stage === 'observe' && tool.surface !== 'general' && event.ok
    && !['computer_status', 'browser_wait', 'desktop_wait'].includes(event.name)
    && (event.name !== 'browser_screenshot' && event.name !== 'computer_window' || event.hasScreenshot);
  const observed = !blocked && !observationFailed && (combinationObserved || standaloneObserved || pageStateAvailable || tool.surface === 'web' && detail?.observation === 'read');
  let verification = previous.verification;
  if (tool.stage === 'act') verification = observed ? 'observation_available' : 'needs_observation';
  else if (observed) verification = 'observation_available';
  else if (['desktop_launch', 'desktop_focus_window', 'browser_viewport', 'browser_switch'].includes(event.name)) verification = 'needs_observation';
  else if (tool.surface !== previous.surface && verification === 'observation_available') verification = 'not_observed';
  const next: FlowState = {
    surface: tool.surface, stage: blocked ? 'blocked' : observed && tool.stage === 'act' ? 'verify' : tool.stage,
    operations: previous.operations + 1, observations: previous.observations + (observed ? 1 : 0),
    verification, lastOperation: event.name,
  };
  if (blocked && code) next.recovery = { code, next: recovery[code] };
  return next;
}
