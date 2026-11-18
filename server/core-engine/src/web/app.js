"use strict";

const byId = (id) => document.getElementById(id);
const ui = {
  form: byId("composer"), input: byId("message"), send: byId("send"),
  cancel: byId("cancel"), reset: byId("reset"), messages: byId("messages"),
  pause: byId("pause"),
  scenario: byId("scenario"), execution: byId("execution"), flow: byId("flow"), modelTiming: byId("model-timing"), recovery: byId("recovery"),
  scenarioHint: byId("scenario-hint"),
  empty: byId("empty"), status: byId("status"), error: byId("error")
};
let state = null;
let connected = false;
let pending = "";
let awaitingState = false;
let actionError = "";
let networkError = "";
let version = 0;
let timer;
let polling = false;
let pollAgain = false;
let renderedMessages = "";
let composing = false;
const scenarioLabels = { auto: "自动", web: "网页", native: "原生应用", visual: "视觉桌面", mixed: "混合", general: "通用" };
const phaseLabels = { idle: "待命", planning: "规划中", model: "模型处理中", tool: "工具执行中", completed: "本轮结束", cancelled: "已停止", failed: "失败" };
const flowStageLabels = { prepare: "准备", observe: "观察", act: "操作", verify: "待验证", blocked: "受阻" };
const flowVerificationLabels = { not_observed: "尚未观察", observation_available: "已有观察，目标结果仍需判断", needs_observation: "待验证" };
const flowSurfaceLabels = { web: "网页", native: "原生应用", visual: "视觉桌面", general: "通用" };
const publicOperationNames = {
  browser_viewport: true, browser_switch: true, browser_tabs: true, browser_read: true, browser_observe: true,
  browser_screenshot: true, browser_dialogs: true, browser_wait: true, browser_wait_for: true, browser_open: true, browser_back: true,
  browser_click: true, browser_fill: true, browser_scroll: true, browser_dialog_accept: true, browser_dialog_dismiss: true,
  browser_session_save: true, browser_session_clear: true, desktop_launch: true, desktop_focus_window: true,
  desktop_list_apps: true, desktop_list_windows: true, desktop_snapshot: true, desktop_wait: true, desktop_click: true,
  desktop_set_value: true, desktop_type: true, desktop_press: true, desktop_click_and_snapshot: true, desktop_set_value_and_snapshot: true,
  computer_status: true, computer_window: true, computer_pause: true, computer_click: true, computer_type: true,
  computer_press_key: true, computer_hotkey: true, computer_scroll: true, computer_action_and_screenshot: true,
  sha256: true, current_time: true, tgb_login_local: true,
};
const recoveryHints = new Map();
for (const [codes, hint] of [
  [["CANCELLED"], "已停止；继续前先观察当前状态，已执行的操作不会撤销。"],
  [["CONDITION_TIMEOUT"], "等待期间尚未观察到条件，请检查界面，不重放操作。"],
  [["STALE_REF", "STALE_REFERENCE", "ELEMENT_NOT_FOUND", "INVALID_REF", "UNKNOWN_REF", "REF_SCOPE_MISMATCH", "OBSERVATION_REQUIRED", "OBSERVATION_FAILED"], "请重新观察并定位界面，不要重复上一写操作。"],
  [["FOCUS_REQUIRED", "NO_FOCUSED_ELEMENT", "APP_NOT_RUNNING", "WINDOW_NOT_FOUND", "STARTUP_FAILED", "AX_UNAVAILABLE"], "请检查应用、窗口与焦点准备，必要时重新观察。"],
  [["PERMISSION_DENIED", "PERMISSION_REQUIRED", "AX_NOT_TRUSTED"], "请手动检查系统权限；不会自动修改授权。"],
  [["ACTION_PENDING", "DIALOG_PENDING"], "前一操作或对话框尚待处理，请先观察，不要重复派发动作。"],
  [["HTTP_ERROR", "NAVIGATION_FAILED", "NAVIGATION_UNCONFIRMED", "PAGE_ERROR"], "请检查页面与网络状态，不要盲目刷新或提交。"],
  [["TOOL_FAILED"], "工具未确认成功，请检查结果与当前界面，不要重复写操作。"],
]) for (const code of codes) recoveryHints.set(code, hint);

function safeMetric(value, integer = false) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(value)) ? value : 0;
}

function safeEnum(value, labels, fallback = "未知") {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : fallback;
}

function supportsScenarios() {
  return Boolean(state && Object.prototype.hasOwnProperty.call(state, "execution"));
}

function renderExecution() {
  const execution = state.execution;
  const duration = (value) => `${(safeMetric(value) / 1000).toFixed(1)} 秒`;
  ui.execution.textContent = execution
    ? `当前场景：${scenarioLabels[execution.scenario] || "未知"}（${execution.source === "user" ? "手动" : "自动"}） · ${safeEnum(execution.phase, phaseLabels, "未知阶段")}${typeof execution.tool === "string" ? ` · ${execution.tool}` : ""} · 总耗时 ${duration(execution.elapsedMs)} · 模型 ${duration(execution.modelMs)} / ${safeMetric(execution.modelRequests, true)} 次 · 工具 ${duration(execution.toolMs)} / ${safeMetric(execution.toolCalls, true)} 次`
    : "当前场景：待运行 · 暂无执行状态";
  const flow = execution?.flow;
  const lastOperation = typeof flow?.lastOperation === "string" && Object.prototype.hasOwnProperty.call(publicOperationNames, flow.lastOperation) ? ` · 最近调用 ${flow.lastOperation}` : "";
  ui.flow.textContent = `流程：${safeEnum(flow?.surface, flowSurfaceLabels, "未知场景")} · ${safeEnum(flow?.stage, flowStageLabels, "未知阶段")} · ${safeEnum(flow?.verification, flowVerificationLabels, "待验证")} · ${safeMetric(flow?.operations, true)} 次调用 / ${safeMetric(flow?.observations, true)} 次有效观察${lastOperation}`;
  const timing = execution?.modelTiming;
  const modelMs = safeMetric(execution?.modelMs);
  const elapsedMs = safeMetric(execution?.elapsedMs);
  const ratio = elapsedMs > 0 ? Math.min(100, Math.max(0, modelMs / elapsedMs * 100)) : null;
  const toolRatio = elapsedMs > 0 ? Math.min(100, Math.max(0, safeMetric(execution?.toolMs) / elapsedMs * 100)) : null;
  const parts = [];
  if (timing && typeof timing === "object") {
    parts.push(`响应头等待 ${duration(timing.headersMs)}`);
    parts.push(timing.firstChunkMeasured === true ? `首块到达（首字节） ${duration(timing.firstChunkMs)}` : "首块到达（首字节）未实测");
    parts.push(`正文接收 ${duration(timing.bodyMs)}`, `JSON解析 ${duration(timing.parseMs)}`, "以上细分仅统计已完成请求；响应头等待包含网络、排队与服务耗时，首字节为 HTTP 正文累计到达时间，不是首 token，不与其他分段相加");
  }
  if (ratio !== null) parts.push(`模型等待占比 ${ratio.toFixed(1)}%（仅该轮，modelMs/总耗时）`);
  if (toolRatio !== null) parts.push(`工具占比 ${toolRatio.toFixed(1)}%`);
  ui.modelTiming.textContent = parts.length ? `模型时间：${parts.join(" · ")}` : "模型时间：暂无足够数据，不排名";
  const recovery = execution?.recovery || flow?.recovery;
  ui.recovery.textContent = recovery
    ? `恢复提示：${recoveryHints.get(recovery.code) || (recovery.code === "CONDITION_TIMEOUT" ? "等待期间尚未观察到条件，请检查界面，不重放操作。" : "执行未确认，请检查当前状态；不要盲目重复操作。")}` : "";
  ui.recovery.hidden = !recovery;
}

function updateControls() {
  const busy = Boolean(state?.busy);
  const closing = Boolean(state?.closing);
  const closed = Boolean(state?.closed);
  const ready = connected && Boolean(state?.token);
  ui.send.disabled = !ready || busy || closing || closed || Boolean(pending) || awaitingState || !ui.input.value.trim();
  ui.reset.disabled = !ready || busy || closing || Boolean(pending) || awaitingState;
  ui.cancel.disabled = !ready || !busy || closing || closed || Boolean(pending) || awaitingState;
  ui.pause.disabled = !ready || busy || closing || closed || Boolean(pending) || awaitingState;
  ui.scenario.disabled = !supportsScenarios() || !ready || busy || closing || closed || Boolean(pending) || awaitingState;
  ui.scenarioHint.textContent = supportsScenarios()
    ? "空闲时可调整，下一条消息生效，不清除记录。当前桌面 AX/CUA 后端固定，选择场景不会切换后端；Reset 后恢复自动。"
    : "当前服务尚不支持场景选择，待服务更新后可用；仍可正常发送消息。当前桌面 AX/CUA 后端固定。";
  // Keep the input visible and editable, including during errors and requests.
  ui.messages.setAttribute("aria-busy", String(busy));
  ui.status.classList.toggle("running", busy && !closing);
  ui.status.textContent = networkError ? "Connection interrupted · retrying automatically…"
    : pending === "cancel" ? "Stopping this run… Conversation history will be kept."
    : pending === "reset" ? "Resetting the session…"
    : closing ? "Waiting for the current operation to settle…"
    : closed ? "Conversation closed. Export or copy your history before Reset; Reset clears all messages."
    : pending === "send" || awaitingState ? "Waiting for the latest conversation state…"
    : busy ? "Running · Stop ends only this run; you can continue afterwards."
    : ready ? "Ready" : "Connecting…";
  const errors = [...new Set([networkError, actionError, state?.error].filter(Boolean).map(String))];
  ui.error.textContent = errors.join("\n");
  ui.error.hidden = errors.length === 0;
}

function renderAttachments(article, attachments) {
  if (!Array.isArray(attachments)) return;
  const images = document.createElement("div");
  images.className = "message-attachments";
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.id !== "string"
      || !/^[A-Za-z0-9_-]+$/.test(attachment.id)
      || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType)
      || attachment.url !== `/api/attachments/${attachment.id}`) continue;
    // Accept only the canonical local endpoint, never arbitrary URLs or active SVG content.
    const name = typeof attachment.name === "string" && attachment.name.trim()
      ? attachment.name : "Screenshot";
    const link = document.createElement("a");
    link.className = "message-attachment";
    link.href = attachment.url;
    const image = document.createElement("img");
    image.src = attachment.url;
    image.alt = name;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    const caption = document.createElement("span");
    caption.textContent = name;
    link.append(image, caption);
    images.append(link);
  }
  if (images.childElementCount) article.append(images);
}

function renderState() {
  byId("model").textContent = state.model || "Not specified";
  byId("backend").textContent = state.backend === "computer_use"
    ? `Computer Use / ${state.desktopBackend === "ax" ? "AX (agent-desktop)" : "CUA (CuaDriver)"}`
    : state.backend || "Not specified";
  for (const [key, id] of [["webModel", "web-model"], ["analysisModel", "analysis-model"]]) {
    byId(id).textContent = state[key] || "—";
    byId(`${id}-row`).hidden = !state[key];
  }
  renderExecution();
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const signature = JSON.stringify(messages);
  if (signature !== renderedMessages) {
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
    const fragment = document.createDocumentFragment();
    if (!messages.length) fragment.append(ui.empty);
    for (const message of messages) {
      const role = ["user", "assistant", "error"].includes(message.role) ? message.role : "assistant";
      const article = document.createElement("article");
      article.className = `message ${role === "error" ? "error-message" : role}`;
      const label = document.createElement("p");
      label.className = "message-label";
      label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Assistant";
      const text = document.createElement("p");
      text.className = "message-text";
      text.textContent = String(message.text ?? "");
      article.append(label, text);
      renderAttachments(article, message.attachments);
      fragment.append(article);
    }
    ui.messages.replaceChildren(fragment);
    renderedMessages = signature;
    if (nearBottom) ui.messages.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
  updateControls();
}

async function request(path, body) {
  {
    const options = { cache: "no-store", credentials: "same-origin" };
    if (body !== undefined) {
      options.method = "POST";
      options.headers = { "Content-Type": "application/json", "X-Session-Token": state.token };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        if (typeof payload.error === "string") detail = `: ${payload.error}`;
      } catch { /* A non-JSON error still has a useful HTTP status. */ }
      throw new Error(`Request failed (${response.status})${detail}`);
    }
    return body === undefined ? await response.json() : null;
  }
}

async function poll() {
  clearTimeout(timer);
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  const revision = version;
  try {
    const next = await request("/api/state");
    if (!next || typeof next.token !== "string" || !next.token || !Array.isArray(next.messages)) {
      throw new Error("The server returned an invalid conversation state.");
    }
    if (revision === version) {
      state = next;
      connected = true;
      networkError = "";
      if (!pending) awaitingState = false;
      renderState();
    }
  } catch (error) {
    if (revision === version) {
      connected = false;
      networkError = `Unable to refresh: ${error.message}`;
      updateControls();
    }
  } finally {
    polling = false;
    const delay = pollAgain ? 0 : 700;
    pollAgain = false;
    timer = setTimeout(poll, delay);
  }
}

async function act(action) {
  const button = ui[action];
  if (button.disabled) return;
  if (action === "cancel" && !window.confirm("Stop only this run? Conversation history will be kept, and you can send another message afterwards. Actions already performed cannot be undone.")) return;
  if (action === "reset" && !window.confirm("Reset this conversation? Export or copy your history first: the session will close and all messages will be cleared.")) return;
  if (action === "pause" && !window.confirm("Stop Computer Use screenshots/input before manual login? Wait for completion before entering secrets.")) return;
  const text = ui.input.value.trim();
  const originalDraft = ui.input.value;
  pending = action;
  awaitingState = true;
  actionError = "";
  version += 1;
  clearTimeout(timer);
  updateControls();
  try {
    const body = action === "send" ? { text } : {};
    if (action === "send" && supportsScenarios()) body.scenario = ui.scenario.value || "auto";
    await request(`/api/${action}`, body);
    if (action === "reset") ui.scenario.value = "auto";
    if (action === "send" && ui.input.value === originalDraft) ui.input.value = "";
  } catch (error) {
    actionError = `${action} could not be confirmed: ${error.message}`;
    // A lost response may still mean the server accepted the operation.
    // Never automatically retry a POST; wait for a fresh GET to confirm the server state.
  } finally {
    pending = "";
    version += 1;
    updateControls();
    poll();
  }
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!composing) void act("send");
});
ui.input.addEventListener("input", updateControls);
ui.input.addEventListener("compositionstart", () => { composing = true; });
ui.input.addEventListener("compositionend", () => { composing = false; });
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault();
    ui.form.requestSubmit();
  }
});
ui.cancel.addEventListener("click", () => { void act("cancel"); });
ui.reset.addEventListener("click", () => { void act("reset"); });
ui.pause.addEventListener("click", () => { void act("pause"); });
void poll();
