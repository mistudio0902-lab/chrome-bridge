const WS_PORT = 9239;
let ws = null;
let backoff = 1000;
let helloPayload = null;
let lastPongAt = 0;
const COMMAND_TIMEOUT_MS = 20000;

function log(...args) { console.log('[BridgeV2/offscreen]', ...args); }

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchHello() {
  const r = await chrome.runtime.sendMessage({ type: 'offscreen_get_hello' }).catch(() => null);
  return r;
}

async function connect() {
  helloPayload = await fetchHello();
  if (!helloPayload) {
    log('hello not ready, retry');
    setTimeout(connect, 500);
    return;
  }

  try { ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`); }
  catch (e) { log('ws ctor failed', e); scheduleReconnect(); return; }

  ws.onopen = () => {
    log('connected');
    backoff = 1000;
    lastPongAt = Date.now();
    ws.send(JSON.stringify({ type: 'hello', ...helloPayload, ts: Date.now() }));
    chrome.runtime.sendMessage({ type: 'offscreen_connected' }).catch(() => {});
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      lastPongAt = Date.now();
      return;
    }

    if (msg.type === 'command') {
      try {
        const result = await withTimeout(
          chrome.runtime.sendMessage({
            type: 'execute',
            command: msg.command
          }),
          COMMAND_TIMEOUT_MS,
          `command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
        );
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { success: false, error: e.message || String(e) } }));
      }
    }
  };

  ws.onclose = () => {
    log('disconnected');
    chrome.runtime.sendMessage({ type: 'offscreen_disconnected' }).catch(() => {});
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  ws = null;
  const delay = backoff;
  backoff = Math.min(backoff * 2, 8000);
  setTimeout(connect, delay);
}

// Keepalive: drop connection if no ping > 60s
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (lastPongAt && Date.now() - lastPongAt > 60000) {
    log('stale connection, closing');
    try { ws.close(); } catch {}
  }
}, 15000);

// Forwarded events from background (debugger console/network)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'forward_event' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'event', name: msg.name, payload: msg.payload }));
  }
});

connect();
