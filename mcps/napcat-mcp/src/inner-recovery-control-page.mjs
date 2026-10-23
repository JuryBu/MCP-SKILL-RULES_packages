export function recoveryControlActionAllowed(state, identity) {
  const text = value => typeof value === "string" && value.length > 0;
  return Boolean(state && identity && state.phase === "waiting" && state.displayState === "waiting"
    && ["not_sent", "rejected"].includes(state.acceptance) && state.canContinueHttp === true
    && state.actionConsumed !== true && state.actionRequired === "choose_http_or_cancel"
    && state.ownerId === identity.ownerId && state.nativeSourceId === identity.nativeSourceId
    && [state.threadId, state.turnId, state.requestId, state.producerId, state.connectionGeneration,
      state.actionToken, identity.instanceToken].every(text)
    && Number.isSafeInteger(state.sequence) && state.sequence > 0
    && Number.isSafeInteger(state.producerPid) && state.producerPid > 0
    && Object.keys(state.sourceHashes ?? {}).sort().join(",") === "control,core,helper,runner"
    && Object.values(state.sourceHashes).every(value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)));
}

export function startInnerRecoveryControlPage() {
  const element = id => document.getElementById(id);
  const fields = ["token", "owner", "source", "instance"];
  const consumed = new Set();
  let credentials = null;
  let epoch = 0;
  let loading = false;
  let submitting = false;
  let timer = null;
  let currentStates = [];
  let continuedRequestKey = null;
  const labels = { waiting: "等待中", retrying: "正在尝试恢复", resumed: "已恢复内容", completed: "已完成",
    failed: "请求失败", stopped: "已取消", cancelled: "已取消" };
  const acceptanceLabels = { not_sent: "尚未发送", rejected: "已拒绝接收", unknown: "接收状态未知", accepted: "已接收" };
  const actionLabels = { choose_http_or_cancel: "可选择继续 HTTP，或回原生界面取消", verify_request_state: "请先核对请求接收状态",
    cancel_or_verify: "回原生界面取消，或等待状态核对", none: "当前无需操作" };
  const valueText = value => String(value ?? "未提供").slice(0, 4096);
  const actionKey = state => JSON.stringify([state.threadId, state.turnId, state.requestId, state.connectionGeneration, state.sequence, state.actionToken]);
  const requestKey = state => JSON.stringify([state.ownerId, state.nativeSourceId, state.producerId, state.producerPid,
    state.connectionGeneration, state.threadId, state.turnId, state.requestId]);
  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = valueText(text);
    if (className) result.className = className;
    return result;
  }
  function feedback(text) { element("feedback").textContent = text; }
  function clearInputs() { for (const field of fields) element(field).value = ""; }
  function controls() {
    element("refresh").disabled = !credentials || loading || submitting;
    element("disconnect").disabled = !credentials;
    for (const button of element("requests").querySelectorAll("button")) button.disabled = true;
  }
  function render() {
    element("requests").replaceChildren();
    controls();
    if (!currentStates.length) {
      element("requests").append(node("p", credentials ? "当前没有恢复请求" : "等待连接", "empty"));
      return;
    }
    for (const state of currentStates) {
      const phase = state.displayState ?? state.phase;
      const article = node("article", undefined, "request");
      article.dataset.phase = phase;
      article.dataset.requestId = valueText(state.requestId);
      const heading = node("div", undefined, "request-head");
      heading.append(node("span", labels[phase] ?? valueText(phase), "badge"), node("span", `sequence ${state.sequence}`, "request-id"));
      article.append(heading);
      const details = node("dl");
      for (const [label, value] of [["当前请求", state.requestId], ["会话 / 回合", `${valueText(state.threadId)} / ${valueText(state.turnId)}`],
        ["原因 · reason", state.reason], ["接收状态 · acceptance", `${acceptanceLabels[state.acceptance] ?? "待核对"} (${valueText(state.acceptance)})`],
        ["下一步 · actionRequired", `${actionLabels[state.actionRequired] ?? "请核对当前状态"} (${valueText(state.actionRequired)})`]]) {
        details.append(node("dt", label), node("dd", value));
      }
      article.append(details);
      const actions = node("div", undefined, "request-actions");
      const button = node("button", "继续 HTTP");
      button.type = "button";
      button.disabled = loading || submitting || consumed.has(actionKey(state)) || !recoveryControlActionAllowed(state, credentials);
      button.addEventListener("click", () => continueHttp(state));
      actions.append(button, node("span", phase === "waiting" && state.willRetry === false
        ? "自动重试已暂停，可回原生界面取消或核对状态" : "取消请回原生界面", "hint"));
      article.append(actions);
      element("requests").append(article);
    }
  }
  function headers(identity) {
    return { authorization: `Bearer ${identity.token}`, "x-inner-owner-id": identity.ownerId,
      "x-inner-native-source-id": identity.nativeSourceId, "x-inner-instance-token": identity.instanceToken };
  }
  async function call(route, identity, body) {
    const response = await fetch(route, { method: body ? "POST" : "GET", headers: {
      ...headers(identity), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), mode: "same-origin", credentials: "omit", cache: "no-store", redirect: "error" });
    if (!response.ok) {
      const error = new Error(response.status === 409 ? "操作已过期、已使用或请求已变化，请刷新状态后核对"
        : response.status === 401 ? "控制口令校验失败，请清除连接后重新填写"
        : response.status === 403 ? "页面来源校验失败，请从本机原控制地址打开"
        : `控制状态暂不可用（HTTP ${response.status}），请刷新核对`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  async function refresh() {
    if (!credentials || loading || submitting) return;
    const identity = credentials;
    const requestEpoch = epoch;
    loading = true;
    controls();
    try {
      const result = await call("/v1/inner/status", identity);
      if (requestEpoch !== epoch) return;
      if (result.ok === false || !Array.isArray(result.coordinator?.recoveryStates)) throw new Error("控制状态格式待核对，请刷新状态");
      currentStates = result.coordinator.recoveryStates;
      element("connection").textContent = "已连接 · 每 2 秒核对真实状态";
      if (element("feedback").textContent === "正在核对当前控制状态") feedback("已读取当前状态，请核对原因和接收状态后选择动作");
      const continued = currentStates.find(state => requestKey(state) === continuedRequestKey);
      const continuationMessages = { resumed: "已收到当前请求的真实内容", completed: "当前请求已完成",
        failed: "当前请求失败，请核对原因", stopped: "当前请求已取消", cancelled: "当前请求已取消" };
      const continuationMessage = continued && continuationMessages[continued.displayState ?? continued.phase];
      if (continuationMessage) feedback(continuationMessage);
    } catch (error) {
      if (requestEpoch !== epoch) return;
      currentStates = [];
      element("connection").textContent = "状态读取失败";
      feedback(error.message);
    } finally {
      if (requestEpoch === epoch) { loading = false; render(); }
    }
  }
  async function continueHttp(state) {
    if (!credentials || loading || submitting || consumed.has(actionKey(state)) || !recoveryControlActionAllowed(state, credentials)) return;
    const identity = credentials;
    const requestEpoch = epoch;
    const key = actionKey(state);
    continuedRequestKey = null;
    consumed.add(key);
    submitting = true;
    controls();
    feedback("正在提交当前请求的一次性继续动作，请等待状态核对");
    const input = { ownerId: identity.ownerId, nativeSourceId: identity.nativeSourceId, instanceToken: identity.instanceToken,
      producerId: state.producerId, producerPid: state.producerPid, connectionGeneration: state.connectionGeneration,
      sourceHashes: { ...state.sourceHashes }, threadId: state.threadId, turnId: state.turnId, requestId: state.requestId,
      sequence: state.sequence, actionToken: state.actionToken };
    try {
      const result = await call("/v1/inner/continue-http", identity, input);
      if (requestEpoch !== epoch) return;
      if (result.accepted === true) continuedRequestKey = requestKey(state);
      feedback(result.accepted === true ? "继续请求已受理，正在等待真实内容" : "当前动作未获接纳，请刷新状态后核对");
    } catch (error) {
      if (requestEpoch !== epoch) return;
      feedback(error.status ? error.message : "提交结果待核对，请刷新当前状态，避免重复提交");
    } finally {
      if (requestEpoch === epoch) { submitting = false; await refresh(); }
    }
  }
  function disconnect() {
    epoch += 1;
    credentials = null;
    loading = false;
    submitting = false;
    currentStates = [];
    continuedRequestKey = null;
    consumed.clear();
    clearInputs();
    clearInterval(timer);
    timer = null;
    element("connection").textContent = "尚未连接";
    feedback("连接身份已清除，重新填写后可查看状态");
    render();
  }
  element("auth-form").addEventListener("submit", event => {
    event.preventDefault();
    const values = fields.map(field => element(field).value.trim());
    if (values.some(value => !value)) { feedback("请填写完整的控制口令和三项身份"); return; }
    disconnect();
    credentials = { token: values[0], ownerId: values[1], nativeSourceId: values[2], instanceToken: values[3] };
    feedback("正在核对当前控制状态");
    refresh();
    timer = setInterval(refresh, 2000);
  });
  element("refresh").addEventListener("click", refresh);
  element("disconnect").addEventListener("click", disconnect);
  window.addEventListener("pagehide", disconnect);
  clearInputs();
  render();
}

export function renderInnerRecoveryControlPage(nonce) {
  if (typeof nonce !== "string" || !/^[a-f0-9]{32,128}$/i.test(nonce)) throw new Error("RECOVERY_PAGE_NONCE_INVALID");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>请求恢复控制</title>
<style nonce="${nonce}">
:root{color-scheme:light;--paper:#f3f1e9;--ink:#172e31;--muted:#536366;--line:#cad1c9;--accent:#9b520c;--green:#276346;--red:#a23831}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:radial-gradient(ellipse at 95% 0,#dce5dc,transparent 55%),var(--paper);font:15px/1.6 "Microsoft YaHei UI","Microsoft YaHei",sans-serif;min-height:100vh}
main{max-width:1180px;margin:auto;padding:38px 32px 60px}header{border-top:5px solid var(--ink);padding:20px 0 26px;display:flex;align-items:end;justify-content:space-between;gap:20px}h1{font:42px/1.2 Cambria,"Microsoft YaHei",serif;letter-spacing:-1px;margin:4px 0 10px}.eyebrow{letter-spacing:.18em;font-size:11px;font-weight:700;color:var(--muted)}p{margin:0 0 12px}.scope{color:var(--muted);max-width:650px}.local{font-size:12px;border:1px solid var(--line);padding:6px 12px;white-space:nowrap}
.workspace{display:grid;grid-template-columns:290px minmax(0,1fr);gap:32px;align-items:start}aside{padding:22px;background:#e6eae2;border-left:3px solid var(--ink)}h2{font-size:20px;margin:0 0 14px}label{display:block;font-size:12px;font-weight:700;margin:12px 0 5px}input{display:block;width:100%;min-width:0;border:1px solid #9caeaa;border-radius:3px;background:#fffef9;padding:10px;color:var(--ink);font:13px "Cascadia Mono",Consolas,monospace}input:focus,button:focus-visible{outline:3px solid #ba7d42;outline-offset:3px}button{font:600 14px "Microsoft YaHei UI",sans-serif;border:1px solid var(--ink);border-radius:3px;padding:10px 15px;color:var(--paper);background:var(--ink);cursor:pointer}button:hover:enabled{background:#315153}button:disabled{opacity:.48;cursor:not-allowed}.secondary{background:transparent;color:var(--ink)}.secondary:hover:enabled{background:#dde4dc}.auth-actions{display:flex;gap:8px;margin:18px 0 12px}.hint{font-size:12px;color:var(--muted)}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:14px}.toolbar h2{margin:0}.connection{font-size:12px;color:var(--muted)}#feedback{border-left:3px solid var(--accent);padding:12px 15px;background:#ebe6d7;margin:17px 0;overflow-wrap:anywhere}.request{padding:22px 0;border-bottom:1px solid var(--line);animation:appear .22s ease-out}.request-head{display:flex;gap:14px;align-items:center;justify-content:space-between;margin-bottom:12px}.badge{display:inline-block;padding:3px 10px;font-size:13px;font-weight:700;border:1px solid currentColor;color:var(--accent)}.request[data-phase="resumed"] .badge,.request[data-phase="completed"] .badge{color:var(--green)}.request[data-phase="failed"] .badge{color:var(--red)}.request[data-phase="cancelled"] .badge{color:var(--muted)}.request-id{font:12px "Cascadia Mono",Consolas,monospace;overflow-wrap:anywhere;color:var(--muted)}dl{display:grid;grid-template-columns:140px minmax(0,1fr);gap:8px 14px;margin:0 0 16px}dt{color:var(--muted);font-size:12px}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.request-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.empty{padding:48px 10px;color:var(--muted);text-align:center;border-bottom:1px solid var(--line)}footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}[hidden]{display:none!important}@keyframes appear{from{opacity:.4;transform:translateY(4px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.request{animation:none}}@media(max-width:760px){main{padding:20px 18px 36px}header{align-items:start;flex-direction:column;gap:6px}h1{font-size:32px}.workspace{grid-template-columns:1fr;gap:24px}aside{padding:18px}dl{grid-template-columns:115px minmax(0,1fr)}.request-head{align-items:start}.local{display:none}}
</style></head><body><main>
<header><div><div class="eyebrow">LOCAL REQUEST CONTROL</div><h1>请求恢复控制</h1><p class="scope">查看真实等待与恢复状态，核对当前请求后选择继续方式</p></div><span class="local">仅本机 · 原控制通路</span></header>
<div class="workspace"><aside><h2>连接控制状态</h2><form id="auth-form" autocomplete="off">
<label for="token">控制口令 · Bearer token</label><input id="token" type="password" autocomplete="off" maxlength="8192" required>
<label for="owner">任务身份 · ownerId</label><input id="owner" autocomplete="off" maxlength="1024" required>
<label for="source">原生来源 · nativeSourceId</label><input id="source" autocomplete="off" maxlength="1024" required>
<label for="instance">实例身份 · instanceToken</label><input id="instance" type="password" autocomplete="off" maxlength="8192" required>
<div class="auth-actions"><button type="submit" id="connect">连接</button><button type="button" id="disconnect" class="secondary" disabled>清除连接</button></div>
</form><p class="hint">凭据由操作者填写，连接后清空输入框，仅在当前页面内存保留，刷新页面后需重新填写</p></aside>
<section aria-label="当前恢复请求"><div class="toolbar"><div><h2>当前请求</h2><span id="connection" class="connection">尚未连接</span></div><button id="refresh" type="button" class="secondary" disabled>刷新状态</button></div>
<p id="feedback" role="status" aria-live="polite">填写本机控制身份后查看状态</p><div id="requests"><p class="empty">等待连接</p></div>
<footer>取消请回原生界面，使用当前回合的取消操作，本页沿用原通路查看状态<br>每段恢复过程的故障历史提示会在恢复后保留</footer></section></div></main>
<script nonce="${nonce}">const recoveryControlActionAllowed = ${recoveryControlActionAllowed.toString()};(${startInnerRecoveryControlPage.toString()})();</script>
</body></html>`;
}
