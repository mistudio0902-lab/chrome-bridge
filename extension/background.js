// Chrome Bridge v2 — background service worker
// Multi-profile-aware bridge between Chrome and MCP server.

const STATE = {
  email: null,
  profileName: null,
  alias: null,
  connected: false,
};

// === Profile init ===
async function loadProfile() {
  const stored = await chrome.storage.local.get(['alias', 'profileName']);
  STATE.alias = stored.alias || null;
  STATE.profileName = stored.profileName || null;

  await new Promise((res) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        STATE.email = info?.email || null;
        res();
      });
    } catch {
      res();
    }
  });

  if (!STATE.profileName) {
    // Best-effort: derive from chrome.runtime.id last 4 chars (per-profile install id)
    STATE.profileName = `profile-${(chrome.runtime.id || '').slice(-4)}`;
    chrome.storage.local.set({ profileName: STATE.profileName });
  }
}

function profileId() {
  return STATE.alias || STATE.email || STATE.profileName || 'default';
}

function helloPayload() {
  return {
    profileId: profileId(),
    email: STATE.email,
    alias: STATE.alias,
    profileName: STATE.profileName,
  };
}

// === Offscreen ===
let offscreenReady = false;
async function ensureOffscreen() {
  if (offscreenReady) return;
  const existing = await chrome.offscreen?.hasDocument?.().catch(() => false) ?? false;
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Maintain WebSocket bridge to MCP server',
    });
  }
  offscreenReady = true;
}

// === Service worker keepalive ===
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // ~24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Touch storage to keep SW alive
    chrome.storage.session.set({ _kp: Date.now() });
  }
});

chrome.runtime.onStartup.addListener(() => init());
chrome.runtime.onInstalled.addListener(() => init());
init();

async function init() {
  await loadProfile();
  await ensureOffscreen();
}

// === Messaging ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'execute') {
    handleCommand(msg.command).then(sendResponse).catch((e) =>
      sendResponse({ success: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'offscreen_get_hello') {
    sendResponse(helloPayload());
    return;
  }
  if (msg.type === 'offscreen_connected') {
    STATE.connected = true;
    return;
  }
  if (msg.type === 'offscreen_disconnected') {
    STATE.connected = false;
    return;
  }
  if (msg.type === 'popup_status') {
    sendResponse({
      ...STATE,
      profileId: profileId(),
    });
    return;
  }
  if (msg.type === 'popup_set_alias') {
    STATE.alias = (msg.alias || '').trim() || null;
    chrome.storage.local.set({ alias: STATE.alias });
    // Reset offscreen to send new hello
    chrome.runtime.sendMessage({ type: 'offscreen_reload' }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'popup_reconnect') {
    chrome.offscreen.closeDocument().then(() => {
      offscreenReady = false;
      ensureOffscreen();
    }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
});

// === Tab helpers ===
async function getActiveTabId(cmd) {
  if (cmd?.tabId) return cmd.tabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function runInTab(tabId, fn, ...args) {
  const execution = chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
    world: 'MAIN',
  });
  const results = await withTimeout(execution, 12000, `page script timed out (tab ${tabId})`);
  return results?.[0]?.result;
}

// A page can stop responding while Chrome still keeps its tab alive (Google
// Sheets is a frequent example). Never let one request hold the command
// channel forever; return an explicit error so later commands can recover.
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForTabLoad(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 300);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// === Debugger (console + network) ===
const dbg = {
  attached: new Set(),
  attaching: new Map(),
  consoleByTab: new Map(),     // tabId -> array of {level,text,ts,source}
  networkByTab: new Map(),     // tabId -> array of {requestId,url,method,status,type,ts}
  maxBuf: 500,
};

async function attachDebugger(tabId) {
  if (dbg.attached.has(tabId)) return;
  if (dbg.attaching.has(tabId)) return dbg.attaching.get(tabId);
  const attaching = (async () => {
    await chrome.debugger.attach({ tabId }, '1.3');
    dbg.attached.add(tabId);
    dbg.consoleByTab.set(tabId, []);
    dbg.networkByTab.set(tabId, []);
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Log.enable').catch(() => {});
  })();
  dbg.attaching.set(tabId, attaching);
  try {
    await attaching;
  } finally {
    dbg.attaching.delete(tabId);
  }
}

function forgetDebugger(tabId) {
  dbg.attached.delete(tabId);
  dbg.attaching.delete(tabId);
  dbg.consoleByTab.delete(tabId);
  dbg.networkByTab.delete(tabId);
}

async function realMouseClick(tabId, x, y) {
  await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0,
  }), 12000, `mouse move timed out (tab ${tabId})`);
  await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  }), 12000, `mouse press timed out (tab ${tabId})`);
  await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  }), 12000, `mouse release timed out (tab ${tabId})`);
}

function jsonSafe(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch {
    return String(value);
  }
}

function parseCdpParams(params) {
  if (params === undefined || params === null || params === '') return {};
  if (typeof params === 'string') {
    const parsed = JSON.parse(params);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('cdp params must be a JSON object');
    }
    return parsed;
  }
  if (Array.isArray(params) || typeof params !== 'object') {
    throw new Error('cdp params must be a JSON object');
  }
  return params;
}

function keyEventParams(key, type) {
  const normalized = String(key || '');
  const special = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13 },
    Escape: { key: 'Escape', code: 'Escape', vk: 27 },
    Tab: { key: 'Tab', code: 'Tab', vk: 9 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  }[normalized];
  if (special) return {
    type,
    key: special.key,
    code: special.code,
    windowsVirtualKeyCode: special.vk,
    nativeVirtualKeyCode: special.vk,
  };
  if (normalized.length === 1) {
    const upper = normalized.toUpperCase();
    const vk = upper.charCodeAt(0);
    return { type, key: normalized, code: `Key${upper}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  }
  throw new Error(`unsupported key: ${normalized}`);
}

async function sendCdpCommand(tabId, method, params) {
  if (typeof method !== 'string' || !method.trim()) {
    throw new Error('cdp method is required');
  }
  await withTimeout(attachDebugger(tabId), 12000, `debugger attach timed out (tab ${tabId})`);
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, parseCdpParams(params)),
    12000,
    `CDP ${method} timed out (tab ${tabId})`,
  );
}

async function getPageFocusState(tabId) {
  const result = await sendCdpCommand(tabId, 'Runtime.evaluate', {
    expression: 'JSON.stringify({visibilityState:document.visibilityState,hasFocus:document.hasFocus()})',
    awaitPromise: true,
    returnByValue: true,
  });
  try {
    return JSON.parse(result?.result?.value || '{}');
  } catch {
    return { visibilityState: null, hasFocus: null };
  }
}

async function ensureVisible(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let windowResult;
  try {
    // This also restores minimized Chrome windows. The extension currently does
    // not request the optional "windows" permission, so retain the precise
    // failure while continuing with CDP focus emulation below.
    const win = await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
    windowResult = { success: true, id: win?.id, state: win?.state, focused: win?.focused };
  } catch (error) {
    windowResult = { success: false, error: error?.message || String(error) };
  }

  await chrome.tabs.update(tabId, { active: true });
  const focusEmulation = await sendCdpCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  let lifecycle;
  try {
    lifecycle = { success: true, result: jsonSafe(await sendCdpCommand(tabId, 'Page.setWebLifecycleState', { state: 'active' })) };
  } catch (error) {
    lifecycle = { success: false, error: error?.message || String(error) };
  }

  return {
    success: true,
    tabId,
    window: windowResult,
    focusEmulation: jsonSafe(focusEmulation),
    lifecycle,
    page: await getPageFocusState(tabId),
  };
}

async function getRealClickTarget(tabId, selector, nth = 0) {
  return runInTab(tabId, async (query, requestedNth) => {
    const parsedNth = Number(requestedNth);
    const index = Number.isInteger(parsedNth) && parsedNth >= 0 ? parsedNth : 0;
    let nodes;
    try {
      nodes = document.querySelectorAll(query);
    } catch (e) {
      return { success: false, error: 'invalid selector: ' + String(e) };
    }
    const element = nodes[index];
    if (!element) return { success: false, error: `selector matched ${nodes.length} element(s); nth ${index} not found` };

    let rect = element.getBoundingClientRect();
    const outsideViewport = rect.bottom < 0 || rect.top > window.innerHeight
      || rect.right < 0 || rect.left > window.innerWidth;
    if (outsideViewport) {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      rect = element.getBoundingClientRect();
    }
    if (rect.width <= 0 || rect.height <= 0) return { success: false, error: 'target has no visible size' };

    return { success: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, nth: index };
  }, selector, nth);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  if (method === 'Runtime.consoleAPICalled' || method === 'Log.entryAdded') {
    const arr = dbg.consoleByTab.get(tabId) || [];
    const entry = method === 'Runtime.consoleAPICalled' ? {
      level: params.type,
      text: (params.args || []).map(a => a.value ?? a.description ?? '').join(' '),
      ts: params.timestamp,
      source: 'console',
    } : {
      level: params.entry?.level,
      text: params.entry?.text,
      ts: params.entry?.timestamp,
      source: params.entry?.source,
    };
    arr.push(entry);
    if (arr.length > dbg.maxBuf) arr.splice(0, arr.length - dbg.maxBuf);
    dbg.consoleByTab.set(tabId, arr);
  } else if (method === 'Network.requestWillBeSent') {
    const arr = dbg.networkByTab.get(tabId) || [];
    arr.push({
      requestId: params.requestId,
      url: params.request?.url,
      method: params.request?.method,
      headers: params.request?.headers || {},
      type: params.type,
      ts: params.timestamp,
      status: null,
    });
    if (arr.length > dbg.maxBuf) arr.splice(0, arr.length - dbg.maxBuf);
    dbg.networkByTab.set(tabId, arr);
  } else if (method === 'Network.responseReceived') {
    const arr = dbg.networkByTab.get(tabId) || [];
    const found = arr.find(r => r.requestId === params.requestId);
    if (found) {
      found.status = params.response?.status;
      found.mimeType = params.response?.mimeType;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) forgetDebugger(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (dbg.attached.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    forgetDebugger(tabId);
  }
});

// === GIF capture ===
const gifState = {
  running: false,
  tabId: null,
  intervalId: null,
  frames: [], // base64 PNG data URLs
  startedAt: 0,
  intervalMs: 600,
};

async function gifTick() {
  if (!gifState.running) return;
  try {
    const tab = await chrome.tabs.get(gifState.tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    gifState.frames.push(dataUrl);
  } catch {}
}

// === Content script functions (run in page MAIN world) ===

function cs_getPageText() {
  function walk(el) {
    if (!el) return '';
    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'noscript', 'svg'].includes(tag)) return '';
    if (el.nodeType === 3) return el.textContent;
    let out = '';
    for (const c of el.childNodes) out += walk(c) + ' ';
    return out;
  }
  return walk(document.body).replace(/\s+/g, ' ').trim().slice(0, 200000);
}

function cs_readPage() {
  return {
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML.slice(0, 500000),
  };
}

function cs_tabContext() {
  return {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    scrollY: window.scrollY,
    scrollX: window.scrollX,
    docHeight: document.documentElement.scrollHeight,
  };
}

function cs_snapshot(maxNodes) {
  const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'label']);
  const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'menuitem', 'tab', 'option', 'switch', 'radio', 'combobox']);
  const result = [];
  let counter = 0;
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (counter >= maxNodes) break;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const isInteractive = interactiveTags.has(tag) ||
      interactiveRoles.has(role) ||
      el.hasAttribute('onclick') ||
      el.tabIndex >= 0;
    if (!isInteractive) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const uid = 'u' + (++counter);
    el.setAttribute('data-bridge-uid', uid);
    const name = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.value || el.innerText || '').trim().slice(0, 120);
    result.push({
      uid,
      tag,
      role: role || null,
      name,
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      visible: rect.bottom > 0 && rect.top < innerHeight,
    });
  }
  return { url: location.href, title: document.title, nodes: result };
}

function cs_find(query) {
  const { text, role, selector, limit } = query;
  const seen = new Set();
  const items = [];
  function add(el) {
    if (seen.has(el)) return;
    seen.add(el);
    if (!el.getAttribute('data-bridge-uid')) {
      el.setAttribute('data-bridge-uid', 'f' + (Math.random().toString(36).slice(2, 8)));
    }
    const rect = el.getBoundingClientRect();
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 120);
    items.push({
      uid: el.getAttribute('data-bridge-uid'),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      name,
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    });
  }
  if (selector) document.querySelectorAll(selector).forEach(add);
  if (role) document.querySelectorAll(`[role="${role}"]`).forEach(add);
  if (text) {
    const lower = text.toLowerCase();
    document.querySelectorAll('a,button,[role="button"],input,label,h1,h2,h3,div,span').forEach(el => {
      const t = (el.innerText || el.value || '').trim();
      if (t && t.toLowerCase().includes(lower) && t.length < 300) add(el);
    });
  }
  return items.slice(0, limit || 25);
}

function cs_resolveUid(uid) {
  return document.querySelector(`[data-bridge-uid="${CSS.escape(uid)}"]`);
}

function cs_clickUidOrSelector(uidOrSel, isUid) {
  const el = isUid
    ? document.querySelector(`[data-bridge-uid="${CSS.escape(uidOrSel)}"]`)
    : document.querySelector(uidOrSel);
  if (!el) return { success: false, error: 'not found: ' + uidOrSel };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  return { success: true };
}

function cs_clickPoint(x, y) {
  const initial = document.elementFromPoint(x, y);
  if (!initial) return { success: false, error: `no element at ${x},${y}` };
  initial.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  const el = document.elementFromPoint(x, y) || initial;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const event = type.startsWith('pointer')
      ? new PointerEvent(type, { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, opts);
    el.dispatchEvent(event);
  }
  if (typeof el.focus === 'function') el.focus();
  return {
    success: true,
    tag: el.tagName,
    text: (el.innerText || el.value || el.getAttribute?.('aria-label') || '').slice(0, 100),
  };
}

function cs_clickPointRaw(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { success: false, error: `no element at ${x},${y}` };
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const event = type.startsWith('pointer')
      ? new PointerEvent(type, { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, opts);
    el.dispatchEvent(event);
  }
  if (typeof el.focus === 'function') el.focus();
  return {
    success: true,
    tag: el.tagName,
    text: (el.innerText || el.value || el.getAttribute?.('aria-label') || '').slice(0, 100),
  };
}

function cs_hover(uidOrSel, isUid) {
  const el = isUid
    ? document.querySelector(`[data-bridge-uid="${CSS.escape(uidOrSel)}"]`)
    : document.querySelector(uidOrSel);
  if (!el) return { success: false, error: 'not found' };
  const rect = el.getBoundingClientRect();
  const opts = { bubbles: true, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 };
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mousemove', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', opts));
  return { success: true };
}

function cs_clickByText(tag, text) {
  const els = document.querySelectorAll(tag || '*');
  for (const el of els) {
    const t = (el.innerText || el.value || '').trim();
    if (t && t.includes(text) && t.length < 500) {
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { success: true, found: t.slice(0, 100) };
    }
  }
  return { success: false, error: 'not found: ' + text };
}

function cs_typeFocused(text) {
  const el = document.activeElement;
  if (!el) return { success: false, error: 'no focused element' };
  // Try contenteditable / Draft.js
  const draft = document.querySelector('[data-testid="tweetTextarea_0"] .public-DraftEditor-content');
  const target = draft || el;
  target.focus();
  for (const ch of text) {
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
    target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
  }
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const proto = Object.getPrototypeOf(target);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(target, (target.value || '') + text);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { success: true };
}

function cs_fill(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: 'not found: ' + selector };
  el.focus();
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    return { success: true };
  }
  return { success: false, error: 'not fillable' };
}

function cs_pressKey(key) {
  const el = document.activeElement || document.body;
  const codeMap = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Space: 32 };
  const code = codeMap[key] || key.charCodeAt(0);
  ['keydown', 'keypress', 'keyup'].forEach(type => {
    el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true }));
  });
  return { success: true };
}

function cs_setSelect(selector, value) {
  const el = document.querySelector(selector);
  if (!el || el.tagName !== 'SELECT') return { success: false, error: 'not a select: ' + selector };
  const opt = Array.from(el.options).find(o => o.value === value || o.text === value);
  if (!opt) return { success: false, error: 'option not found', options: Array.from(el.options).map(o => o.text) };
  el.value = opt.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, selected: opt.text };
}

function cs_scroll(amountOrSelector) {
  if (typeof amountOrSelector === 'number') {
    window.scrollBy(0, amountOrSelector);
    return { scrollY: window.scrollY };
  }
  const el = document.querySelector(amountOrSelector);
  if (!el) return { success: false, error: 'selector not found' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return { success: true, scrollY: window.scrollY };
}

function cs_evaluate(scriptSrc) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('scriptSrc', 'return (async () => { return await eval(scriptSrc); })();');
    return Promise.resolve(fn(scriptSrc)).then(
      val => ({ ok: true, val: safeSerialize(val) }),
      err => ({ ok: false, err: String(err) })
    );
    function safeSerialize(v) {
      try {
        const json = JSON.stringify(v);
        return json === undefined ? String(v) : JSON.parse(json);
      }
      catch { return String(v); }
    }
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

function cs_waitFor(opts) {
  const start = Date.now();
  const timeout = opts.timeout || 8000;
  return new Promise(resolve => {
    function check() {
      if (opts.selector && document.querySelector(opts.selector)) return resolve({ success: true, matched: 'selector' });
      if (opts.text && document.body && document.body.innerText.includes(opts.text)) return resolve({ success: true, matched: 'text' });
      if (Date.now() - start > timeout) return resolve({ success: false, error: 'timeout' });
      setTimeout(check, 200);
    }
    check();
  });
}

// === Main command dispatcher ===
async function handleCommand(cmd) {
  await ensureOffscreen();
  const action = cmd.action;

  switch (action) {
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return { success: true, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) };
    }
    case 'tabs_create': {
      const tab = await chrome.tabs.create({ url: cmd.url || 'about:blank', active: cmd.active !== false });
      if (cmd.url) await waitForTabLoad(tab.id);
      return { success: true, tabId: tab.id };
    }
    case 'tabs_close': {
      await chrome.tabs.remove(cmd.tabId);
      return { success: true };
    }
    case 'tabs_select': {
      await chrome.tabs.update(cmd.tabId, { active: true });
      return { success: true };
    }
    case 'cdp': {
      const id = await getActiveTabId(cmd);
      const result = await sendCdpCommand(id, cmd.method, cmd.params);
      return { success: true, tabId: id, method: cmd.method, result: jsonSafe(result) };
    }
    case 'ensure_visible': {
      const id = await getActiveTabId(cmd);
      return ensureVisible(id);
    }
    case 'tab_context': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_tabContext);
      const tab = await chrome.tabs.get(id);
      return { success: true, tabId: id, windowId: tab.windowId, ...r };
    }

    case 'navigate': {
      const id = await getActiveTabId(cmd);
      await chrome.tabs.update(id, { url: cmd.url });
      await waitForTabLoad(id);
      return { success: true, tabId: id };
    }
    case 'back': {
      const id = await getActiveTabId(cmd);
      await chrome.tabs.goBack(id);
      await waitForTabLoad(id);
      return { success: true };
    }
    case 'forward': {
      const id = await getActiveTabId(cmd);
      await chrome.tabs.goForward(id);
      await waitForTabLoad(id);
      return { success: true };
    }
    case 'reload': {
      const id = await getActiveTabId(cmd);
      await chrome.tabs.reload(id);
      await waitForTabLoad(id);
      return { success: true };
    }
    case 'wait_for': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_waitFor, { selector: cmd.selector, text: cmd.text, timeout: cmd.timeout });
      return r;
    }

    case 'screenshot': {
      const id = await getActiveTabId(cmd);
      const tab = await chrome.tabs.get(id);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: cmd.format || 'png' });
      return { success: true, data: dataUrl };
    }
    case 'read_page': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_readPage);
      return { success: true, ...r };
    }
    case 'read_page_debugger': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const docNode = await chrome.debugger.sendCommand({ tabId: id }, 'DOM.getDocument', { depth: 0 });
      const html = await chrome.debugger.sendCommand({ tabId: id }, 'DOM.getOuterHTML', { nodeId: docNode.root.nodeId });
      return { success: true, html: html.outerHTML };
    }
    case 'dom_search_debugger': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const query = cmd.query || '';
      const limit = Math.max(1, Math.min(20, cmd.limit || 5));
      const search = await chrome.debugger.sendCommand({ tabId: id }, 'DOM.performSearch', { query, includeUserAgentShadowDOM: true });
      const count = Math.min(search.resultCount || 0, limit);
      const results = count
        ? await chrome.debugger.sendCommand({ tabId: id }, 'DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: count })
        : { nodeIds: [] };
      const items = [];
      for (const nodeId of results.nodeIds || []) {
        try {
          const node = await chrome.debugger.sendCommand({ tabId: id }, 'DOM.describeNode', { nodeId, depth: 0 });
          const html = await chrome.debugger.sendCommand({ tabId: id }, 'DOM.getOuterHTML', { nodeId });
          items.push({ nodeId, nodeName: node.node?.nodeName, outerHTML: html.outerHTML });
        } catch (e) {
          items.push({ nodeId, error: e?.message || String(e) });
        }
      }
      await chrome.debugger.sendCommand({ tabId: id }, 'DOM.discardSearchResults', { searchId: search.searchId }).catch(() => {});
      return { success: true, resultCount: search.resultCount || 0, items };
    }
    case 'get_cookies_debugger': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const r = await chrome.debugger.sendCommand({ tabId: id }, 'Network.getCookies', { urls: cmd.urls || [] });
      return { success: true, cookies: r.cookies || [] };
    }
    case 'get_page_text': {
      const id = await getActiveTabId(cmd);
      const text = await runInTab(id, cs_getPageText);
      return { success: true, text };
    }
    case 'snapshot': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_snapshot, cmd.maxNodes || 300);
      return { success: true, ...r };
    }
    case 'find': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_find, { text: cmd.text, role: cmd.role, selector: cmd.selector, limit: cmd.limit });
      return { success: true, items: r };
    }

    case 'click': {
      const id = await getActiveTabId(cmd);
      const target = cmd.uid || cmd.selector;
      if (!target) return { success: false, error: 'uid or selector required' };
      const r = await runInTab(id, cs_clickUidOrSelector, target, !!cmd.uid);
      return r;
    }
    case 'real_click': {
      const id = await getActiveTabId(cmd);
      let x = Number(cmd.x);
      let y = Number(cmd.y);
      let target = null;
      if (cmd.selector) {
        target = await getRealClickTarget(id, cmd.selector, cmd.nth);
        if (!target?.success) return target || { success: false, error: 'failed to resolve target' };
        x = target.x;
        y = target.y;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: 'x and y coordinates, or selector, are required' };
      }
      await withTimeout(attachDebugger(id), 12000, `debugger attach timed out (tab ${id})`);
      await realMouseClick(id, x, y);
      return { success: true, tabId: id, x, y, ...(target ? { nth: target.nth } : {}) };
    }
    case 'click_point': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_clickPoint, cmd.x, cmd.y);
      return r;
    }
    case 'click_point_raw': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_clickPointRaw, cmd.x, cmd.y);
      return r;
    }
    case 'click_by_text': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_clickByText, cmd.tag || '*', cmd.text);
      return r;
    }
    case 'hover': {
      const id = await getActiveTabId(cmd);
      const target = cmd.uid || cmd.selector;
      const r = await runInTab(id, cs_hover, target, !!cmd.uid);
      return r;
    }
    case 'type_text': {
      const id = await getActiveTabId(cmd);
      if (cmd.selector) {
        const f = await runInTab(id, cs_fill, cmd.selector, cmd.text);
        return f;
      }
      const r = await runInTab(id, cs_typeFocused, cmd.text);
      return r;
    }
    case 'real_type': {
      const id = await getActiveTabId(cmd);
      if (typeof cmd.text !== 'string') return { success: false, error: 'text is required' };
      let target = null;
      await withTimeout(attachDebugger(id), 12000, `debugger attach timed out (tab ${id})`);
      if (cmd.selector) {
        target = await getRealClickTarget(id, cmd.selector, cmd.nth);
        if (!target?.success) return target || { success: false, error: 'failed to resolve target' };
        await realMouseClick(id, target.x, target.y);
      }
      await withTimeout(
        chrome.debugger.sendCommand({ tabId: id }, 'Input.insertText', { text: cmd.text }),
        12000,
        `text insertion timed out (tab ${id})`,
      );
      return { success: true, tabId: id, textLength: cmd.text.length, ...(target ? { x: target.x, y: target.y, nth: target.nth } : {}) };
    }
    case 'sheet_set_cell': {
      // Google Sheets owns its grid in canvas.  Route all editing through the
      // name box and the real formula-bar editor so IME/text events are trusted.
      const id = await getActiveTabId(cmd);
      if (typeof cmd.cell !== 'string' || typeof cmd.text !== 'string') {
        return { success: false, error: 'cell and text are required' };
      }
      await runInTab(id, cs_fill, '#t-name-box', cmd.cell);
      await sendCdpCommand(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      await sendCdpCommand(id, 'Input.dispatchKeyEvent', keyEventParams('Enter', 'keyUp'));
      const target = await getRealClickTarget(id, '#waffle-rich-text-editor');
      if (!target?.success) return target || { success: false, error: 'formula editor not found' };
      await realMouseClick(id, target.x, target.y);
      await sendCdpCommand(id, 'Input.insertText', { text: cmd.text });
      await sendCdpCommand(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      await sendCdpCommand(id, 'Input.dispatchKeyEvent', keyEventParams('Enter', 'keyUp'));
      return { success: true, tabId: id, cell: cmd.cell, textLength: cmd.text.length };
    }
    case 'sheet_paste_cell': {
      // Google Sheets ignores Input.insertText for canvas-backed cells. Navigate
      // through the name box with trusted CDP events, then let Sheets handle a
      // real Ctrl+V from the system clipboard as a cell replacement.
      const id = await getActiveTabId(cmd);
      if (typeof cmd.cell !== 'string') {
        return { success: false, error: 'cell is required' };
      }
      const nameBox = await getRealClickTarget(id, '#t-name-box');
      if (!nameBox?.success) return nameBox || { success: false, error: 'name box not found' };
      await withTimeout(attachDebugger(id), 12000, `debugger attach timed out (tab ${id})`);
      await realMouseClick(id, nameBox.x, nameBox.y);
      const key = (type, key, code, vk, modifiers = 0, text) => {
        const p = { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
        if (text !== undefined) {
          p.text = text;
          p.unmodifiedText = text;
        }
        return sendCdpCommand(id, 'Input.dispatchKeyEvent', p);
      };
      await key('rawKeyDown', 'Control', 'ControlLeft', 17, 2);
      await key('rawKeyDown', 'a', 'KeyA', 65, 2);
      await key('keyUp', 'a', 'KeyA', 65, 2);
      await key('keyUp', 'Control', 'ControlLeft', 17);
      await sendCdpCommand(id, 'Input.insertText', { text: cmd.cell });
      await key('keyDown', 'Enter', 'Enter', 13, 0, '\r');
      await key('keyUp', 'Enter', 'Enter', 13);
      await key('rawKeyDown', 'Control', 'ControlLeft', 17, 2);
      await key('rawKeyDown', 'v', 'KeyV', 86, 2);
      await key('keyUp', 'v', 'KeyV', 86, 2);
      await key('keyUp', 'Control', 'ControlLeft', 17);
      return { success: true, tabId: id, cell: cmd.cell };
    }
    case 'fill': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_fill, cmd.selector, cmd.value);
      return r;
    }
    case 'form_input': {
      const id = await getActiveTabId(cmd);
      const results = [];
      for (const f of (cmd.fields || [])) {
        results.push(await runInTab(id, cs_fill, f.selector, f.value));
      }
      return { success: true, results };
    }
    case 'set_select': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_setSelect, cmd.selector, cmd.value);
      return r;
    }
    case 'press_key': {
      const id = await getActiveTabId(cmd);
      await sendCdpCommand(id, 'Input.dispatchKeyEvent', keyEventParams(cmd.key, 'rawKeyDown'));
      await sendCdpCommand(id, 'Input.dispatchKeyEvent', keyEventParams(cmd.key, 'keyUp'));
      return { success: true, tabId: id, key: cmd.key };
    }
    case 'scroll': {
      const id = await getActiveTabId(cmd);
      const r = await runInTab(id, cs_scroll, cmd.selector || (cmd.amount ?? 600));
      return { success: true, ...r };
    }
    case 'evaluate': {
      const id = await getActiveTabId(cmd);
      const script = typeof cmd.script === 'string' ? cmd.script : cmd.expression;
      if (typeof script !== 'string') return { success: false, error: 'evaluate requires a string expression or script' };
      const r = await runInTab(id, cs_evaluate, script);
      if (!r) return { success: false, error: 'no result' };
      if (!r.ok) return { success: false, error: r.err };
      return { success: true, result: r.val };
    }
    case 'evaluate_debugger': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const r = await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', {
        expression: cmd.script,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        return { success: false, error: r.exceptionDetails.text || 'Runtime.evaluate failed', exceptionDetails: r.exceptionDetails };
      }
      return { success: true, result: r.result?.value };
    }
    case 'upload_file': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const docNode = await chrome.debugger.sendCommand({ tabId: id }, 'DOM.getDocument', { depth: -1 });
      const root = docNode.root.nodeId;
      const found = await chrome.debugger.sendCommand({ tabId: id }, 'DOM.querySelector', { nodeId: root, selector: cmd.selector });
      if (!found || !found.nodeId) return { success: false, error: 'input not found' };
      await chrome.debugger.sendCommand({ tabId: id }, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: cmd.files });
      return { success: true };
    }

    case 'resize_window': {
      const id = await getActiveTabId(cmd);
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { width: cmd.width, height: cmd.height });
      return { success: true };
    }

    case 'read_console_messages': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const arr = dbg.consoleByTab.get(id) || [];
      const filtered = cmd.pattern ? arr.filter(m => new RegExp(cmd.pattern, 'i').test(m.text || '')) : arr;
      const limit = cmd.limit || 100;
      return { success: true, messages: filtered.slice(-limit) };
    }
    case 'read_network_requests': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const arr = dbg.networkByTab.get(id) || [];
      const filtered = cmd.pattern ? arr.filter(r => new RegExp(cmd.pattern, 'i').test(r.url || '')) : arr;
      const limit = cmd.limit || 100;
      return { success: true, requests: filtered.slice(-limit) };
    }
    case 'find_network_body_regex': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const regex = new RegExp(cmd.pattern, cmd.flags || '');
      const arr = dbg.networkByTab.get(id) || [];
      const filtered = cmd.urlPattern ? arr.filter(r => new RegExp(cmd.urlPattern, 'i').test(r.url || '')) : arr;
      for (const item of filtered.slice().reverse()) {
        try {
          const body = await chrome.debugger.sendCommand({ tabId: id }, 'Network.getResponseBody', { requestId: item.requestId });
          const text = body.base64Encoded ? atob(body.body || '') : (body.body || '');
          const match = text.match(regex);
          if (match) return { success: true, found: match[0], url: item.url, status: item.status };
        } catch {}
      }
      return { success: true, found: null };
    }

    case 'gif_start': {
      if (gifState.running) return { success: false, error: 'already running' };
      const id = await getActiveTabId(cmd);
      gifState.running = true;
      gifState.tabId = id;
      gifState.frames = [];
      gifState.startedAt = Date.now();
      gifState.intervalMs = Math.max(500, cmd.intervalMs || 600);
      gifState.intervalId = setInterval(gifTick, gifState.intervalMs);
      return { success: true, tabId: id, intervalMs: gifState.intervalMs };
    }
    case 'gif_stop': {
      if (!gifState.running) return { success: false, error: 'not running' };
      gifState.running = false;
      clearInterval(gifState.intervalId);
      const frames = gifState.frames;
      const meta = { count: frames.length, intervalMs: gifState.intervalMs, durationMs: Date.now() - gifState.startedAt };
      gifState.frames = [];
      return { success: true, frames, meta };
    }

    case 'reload_extension': {
      setTimeout(() => chrome.runtime.reload(), 300);
      return { success: true };
    }

    case 'detach_debugger': {
      const id = await getActiveTabId(cmd);
      if (dbg.attached.has(id)) {
        await chrome.debugger.detach({ tabId: id }).catch(() => {});
      }
      forgetDebugger(id);
      return { success: true, tabId: id };
    }

    case 'ping': {
      return { success: true, pong: true, profileId: profileId() };
    }

    // 全 cookie 取得 (httpOnly 含む) — CDP Network.getCookies 経由
    case 'get_all_cookies': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const urls = cmd.urls || undefined;
      const r = await chrome.debugger.sendCommand(
        { tabId: id },
        'Network.getCookies',
        urls ? { urls } : {}
      );
      return { success: true, cookies: r.cookies };
    }

    // CSP をバイパスする debugger 経由 JS 実行 (cookie 取得など)
    case 'debug_eval': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const r = await chrome.debugger.sendCommand(
        { tabId: id },
        'Runtime.evaluate',
        { expression: cmd.script, returnByValue: true, awaitPromise: true }
      );
      if (r.exceptionDetails) {
        return { success: false, error: r.exceptionDetails.text || JSON.stringify(r.exceptionDetails) };
      }
      return { success: true, result: r.result?.value };
    }

    case 'debug_command': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const cdpMethod = cmd.cdpMethod || cmd.method;
      if (!cdpMethod) return { success: false, error: 'missing cdpMethod', keys: Object.keys(cmd) };
      const r = await chrome.debugger.sendCommand(
        { tabId: id },
        cdpMethod,
        cmd.params || {}
      );
      return { success: true, result: r };
    }

    case 'debug_insert_text': {
      const id = await getActiveTabId(cmd);
      await attachDebugger(id);
      const r = await chrome.debugger.sendCommand(
        { tabId: id },
        'Input.insertText',
        { text: cmd.text || '' }
      );
      return { success: true, result: r };
    }

    default:
      return { success: false, error: 'unknown action: ' + action };
  }
}
