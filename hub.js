import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';

const WS_PORT = Number.parseInt(process.env.CHROME_BRIDGE_WS_PORT || '9239', 10);
const HTTP_PORT = Number.parseInt(process.env.CHROME_BRIDGE_HTTP_PORT || '9240', 10);
const HOST = '127.0.0.1';
const PROFILE_GRACE_MS = 180000;
const PING_RETRY_ATTEMPTS = 2;
const PING_RETRY_DELAY_MS = 10000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const LONG_COMMAND_TIMEOUT_MS = 90000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 20000;
const TEMPORARY_DISCONNECT_ERROR = 'extension temporarily disconnected, retry in 5s';
const ALLOW_PORT_TAKEOVER = process.env.CHROME_BRIDGE_TAKEOVER === '1';
const DEFAULT_CHROME_EXE = detectChromeExe();
const CHROME_EXE = process.env.CHROME_BRIDGE_CHROME_EXE || DEFAULT_CHROME_EXE;
const CHROME_EXE_ARGS = parseChromeExeArgs(process.env.CHROME_BRIDGE_CHROME_EXE_ARGS);
const USER_DATA_DIR = process.env.CHROME_BRIDGE_USER_DATA_DIR
  || join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');

const profiles = new Map();
let cmdId = 0;
const pending = new Map();
let lastCommandTime = null;
let keepaliveTimer = null;

function log(...a) {
  process.stderr.write('[bridge-hub] ' + a.join(' ') + '\n');
}

function detectChromeExe() {
  const candidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function parseChromeExeArgs(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {}
  return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

process.on('uncaughtException', (e) => log('uncaughtException:', e?.stack || e?.message || e));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.stack || e?.message || e));

function wsStateName(ws) {
  if (!ws) return 'missing';
  return ['connecting', 'open', 'closing', 'closed'][ws.readyState] || `unknown:${ws.readyState}`;
}

function commandTimeoutMs(action) {
  return action === 'evaluate'
    || action === 'evaluate_debugger'
    || action === 'cdp'
    || action === 'ensure_visible'
    || action === 'real_click'
    || action === 'real_type'
    || action === 'debug_command'
    || action === 'read_page_debugger'
    || action === 'dom_search_debugger'
    || action === 'get_cookies_debugger'
    || action === 'navigate'
    ? LONG_COMMAND_TIMEOUT_MS
    : DEFAULT_COMMAND_TIMEOUT_MS;
}

function safeWsSend(ws, payload, context = 'ws.send') {
  try {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  } catch (e) {
    log(`${context} failed:`, e?.message || e);
    return false;
  }
}

function safeWsClose(ws, context = 'ws.close') {
  try {
    if (ws && ws.readyState < 2) ws.close();
  } catch (e) {
    log(`${context} failed:`, e?.message || e);
  }
}

function killPortHolder(port) {
  try {
    const out = execSync('netstat -ano', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split('\n')) {
      if (!line.includes(`${HOST}:${port}`) || !line.includes('LISTENING')) continue;
      const pid = Number.parseInt(line.trim().split(/\s+/).pop(), 10);
      if (!pid || pid === process.pid) continue;
      try {
        execSync(`powershell -Command "Stop-Process -Id ${pid} -Force"`, {
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        execSync(`taskkill /PID ${pid} /F`, {
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
      log(`killed pid ${pid} holding :${port}`);
    }
  } catch {}
}

function evictProfile(id, reason) {
  const p = profiles.get(id);
  if (!p) return;
  if (p.pingRetryTimer) clearTimeout(p.pingRetryTimer);
  profiles.delete(id);
  log(`evicted: ${id} (${reason})`);
}

function schedulePingRetry(id, p) {
  if (p.pingRetryTimer) return;

  const retry = () => {
    const current = profiles.get(id);
    if (!current || current.ws !== p.ws) return;

    if (Date.now() - current.lastSeen <= PROFILE_GRACE_MS) {
      current.pingRetryAttempts = 0;
      current.pingRetryTimer = null;
      return;
    }

    if (current.ws.readyState !== 1) {
      evictProfile(id, 'websocket closed during ping retry');
      return;
    }

    if (current.pingRetryAttempts >= PING_RETRY_ATTEMPTS) {
      evictProfile(id, 'ping grace expired');
      return;
    }

    current.pingRetryAttempts += 1;
    safeWsSend(current.ws, { type: 'ping', ts: Date.now(), retry: current.pingRetryAttempts }, 'ping retry');
    current.pingRetryTimer = setTimeout(retry, PING_RETRY_DELAY_MS);
  };

  p.pingRetryTimer = setTimeout(retry, PING_RETRY_DELAY_MS);
}

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    for (const [id, p] of profiles) {
      if (p.ws.readyState !== 1) {
        if (Date.now() - p.lastSeen > PROFILE_GRACE_MS) evictProfile(id, 'websocket closed after grace period');
        continue;
      }
      safeWsSend(p.ws, { type: 'ping', ts: Date.now() }, 'keepalive ping');
      if (Date.now() - p.lastSeen > PROFILE_GRACE_MS) schedulePingRetry(id, p);
    }
  }, 30000);
}

function listProfileObjects() {
  return [...profiles.entries()].map(([id, p]) => ({
    profileId: id,
    email: p.hello?.email,
    alias: p.hello?.alias,
    profileName: p.hello?.profileName,
    active: false,
    lastSeen: p.lastSeen,
    wsState: wsStateName(p.ws),
  }));
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function profileConnectedByEmail(email) {
  const requested = normalize(email);
  if (!requested) return null;
  for (const [id, p] of profiles) {
    if (normalize(p.hello?.email) === requested) return id;
  }
  return null;
}

function connectedProfileMatchesTarget(id, p, target) {
  const requested = normalize(target);
  if (!requested) return false;
  const values = [
    id,
    p.hello?.email,
    p.hello?.alias,
    p.hello?.profileId,
    p.hello?.profileName,
  ].map(normalize).filter(Boolean);
  return values.some((value) => value === requested)
    || values.some((value) => value.includes(requested) || requested.includes(value));
}

function findConnectedProfile(target) {
  const requested = normalize(target);
  if (!requested) return null;

  for (const [id, p] of profiles) {
    if (normalize(p.hello?.email) === requested) return id;
  }

  const matches = [...profiles.entries()]
    .filter(([id, p]) => connectedProfileMatchesTarget(id, p, target))
    .map(([id]) => id);
  return matches.length === 1 ? matches[0] : null;
}

function readInfoCache() {
  try {
    const raw = readFileSync(join(USER_DATA_DIR, 'Local State'), 'utf8');
    const parsed = JSON.parse(raw);
    const cache = parsed?.profile?.info_cache || {};
    return Object.entries(cache).map(([dir, info]) => ({
      dir,
      email: info?.user_name || '',
      name: info?.name || '',
      gaiaName: info?.gaia_name || '',
    }));
  } catch {
    return [];
  }
}

function listLaunchableProfiles() {
  return readInfoCache().map((entry) => ({
    dir: entry.dir,
    email: entry.email,
    name: entry.name,
    connected: Boolean(profileConnectedByEmail(entry.email)),
  }));
}

function resolveLaunchableProfile(target) {
  const requested = normalize(target);
  const entries = readInfoCache();
  if (!requested) return { error: 'missing profile', matches: [], entries };

  const emailMatches = entries.filter((entry) => normalize(entry.email) === requested);
  if (emailMatches.length === 1) return { entry: emailMatches[0], entries };
  if (emailMatches.length > 1) return { error: 'ambiguous profile', matches: emailMatches, entries };

  const exactMatches = entries.filter((entry) => [
    entry.name,
    entry.gaiaName,
    entry.dir,
  ].some((value) => normalize(value) === requested));
  if (exactMatches.length === 1) return { entry: exactMatches[0], entries };
  if (exactMatches.length > 1) return { error: 'ambiguous profile', matches: exactMatches, entries };

  const partialMatches = entries.filter((entry) => [
    entry.email,
    entry.name,
    entry.gaiaName,
    entry.dir,
  ].some((value) => {
    const normalized = normalize(value);
    return normalized && (normalized.includes(requested) || requested.includes(normalized));
  }));
  if (partialMatches.length === 1) return { entry: partialMatches[0], entries };
  if (partialMatches.length > 1) return { error: 'ambiguous profile', matches: partialMatches, entries };

  return { error: 'profile not found', matches: [], entries };
}

function launchProfileError(status, error, details = {}) {
  const e = new Error(error);
  e.status = status;
  e.payload = {
    success: false,
    error,
    launchableProfiles: listLaunchableProfiles(),
    ...details,
  };
  return e;
}

function profileError(status, error) {
  const e = new Error(error);
  e.status = status;
  e.payload = {
    success: false,
    error,
    profiles: listProfileObjects(),
  };
  return e;
}

function resolveProfile(profile) {
  const requested = String(profile || '').trim();
  if (!requested) {
    throw profileError(400, 'missing profile. specify one of the connected profiles.');
  }
  if (profiles.has(requested)) return requested;

  const partialMatches = [...profiles.keys()].filter((id) => id.includes(requested) || requested.includes(id));
  if (partialMatches.length === 1) return partialMatches[0];

  const suffix = partialMatches.length > 1
    ? ` ambiguous matches: [${partialMatches.join(', ')}]`
    : '';
  throw profileError(400, `profile not found: ${requested}.${suffix}`);
}

function isTemporaryDisconnectionError(e) {
  const msg = String(e?.message || e || '');
  return msg.includes(TEMPORARY_DISCONNECT_ERROR)
    || msg.includes('no profile connected')
    || msg.includes('profile not connected')
    || msg.includes('WebSocket is not open');
}

function sendCommand(profileId, command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  const p = profiles.get(profileId);
  if (!p || p.ws.readyState !== 1) throw new Error(TEMPORARY_DISCONNECT_ERROR);
  return new Promise((resolve, reject) => {
    const id = ++cmdId;
    lastCommandTime = Date.now();
    pending.set(id, { resolve, reject, profileId });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`timeout ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    if (!safeWsSend(p.ws, { type: 'command', id, command }, `command ${command?.action || 'unknown'}`)) {
      pending.delete(id);
      reject(new Error(TEMPORARY_DISCONNECT_ERROR));
    }
  });
}

function spawnChromeProfile(dir, url) {
  const args = [
    ...CHROME_EXE_ARGS,
    `--profile-directory=${dir}`,
    ...(url ? [String(url)] : []),
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CHROME_EXE, args, {
        detached: true,
        stdio: 'ignore',
      });
    } catch (e) {
      reject(e);
      return;
    }

    let settled = false;
    child.once('error', (e) => {
      if (settled) {
        log('chrome launch error:', e?.message || e);
        return;
      }
      settled = true;
      reject(e);
    });
    child.once('spawn', () => {
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function findLaunchedProfile(entry, target) {
  const email = normalize(entry?.email);
  const requested = normalize(target);
  for (const [id, p] of profiles) {
    if (email && normalize(p.hello?.email) === email) return id;
    if (requested && normalize(p.hello?.profileId) === requested) return id;
  }
  return null;
}

async function waitForLaunchedProfile(entry, target, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const profileId = findLaunchedProfile(entry, target);
    if (profileId) return profileId;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function startWss(retry = 0) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: HOST, port: WS_PORT });

    wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (ALLOW_PORT_TAKEOVER) {
          log(`port ${WS_PORT} in use, killing holder...`);
          killPortHolder(WS_PORT);
        } else {
          log(`port ${WS_PORT} in use, waiting for holder to exit...`);
        }
        setTimeout(() => resolve(startWss(retry + 1)), 1500);
      } else {
        log('wss error:', err.message);
      }
    });

    wss.on('listening', () => {
      log(`WebSocket ready on ws://${HOST}:${WS_PORT}`);
      startKeepalive();
      resolve(wss);
    });

    wss.on('connection', (ws) => {
      let myId = null;

      ws.on('error', (err) => log('ws error:', err?.message || err));

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }

        if (msg.type === 'hello') {
          myId = (msg.alias || msg.email || msg.profileId || `anon-${Math.random().toString(36).slice(2, 6)}`).trim();
          const prev = profiles.get(myId);
          if (prev?.ws !== ws) safeWsClose(prev?.ws, 'replace profile ws.close');
          if (prev?.pingRetryTimer) clearTimeout(prev.pingRetryTimer);
          profiles.set(myId, {
            ws,
            hello: msg,
            lastSeen: Date.now(),
            disconnectedAt: null,
            pingRetryAttempts: 0,
            pingRetryTimer: null,
          });
          log(`connected: ${myId} (email=${msg.email || '-'})`);
          return;
        }

        if (msg.type === 'pong') {
          const p = profiles.get(myId);
          if (p) {
            p.lastSeen = Date.now();
            p.disconnectedAt = null;
            p.pingRetryAttempts = 0;
            if (p.pingRetryTimer) {
              clearTimeout(p.pingRetryTimer);
              p.pingRetryTimer = null;
            }
          }
          return;
        }

        if (msg.type === 'result') {
          const r = pending.get(msg.id);
          if (r) {
            pending.delete(msg.id);
            r.resolve(msg.result);
          }
        }
      });

      ws.on('close', () => {
        if (myId && profiles.get(myId)?.ws === ws) {
          const p = profiles.get(myId);
          p.disconnectedAt = Date.now();
          log(`disconnected: ${myId}; keeping profile for grace period`);
          for (const [id, r] of pending) {
            if (r.profileId === myId) {
              pending.delete(id);
              r.reject(new Error(TEMPORARY_DISCONNECT_ERROR));
            }
          }
        }
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function healthPayload() {
  const now = Date.now();
  const wsState = {};
  const profileAges = {};
  for (const [id, p] of profiles) {
    wsState[id] = wsStateName(p.ws);
    profileAges[id] = {
      lastSeenMsAgo: now - p.lastSeen,
      disconnectedMsAgo: p.disconnectedAt ? now - p.disconnectedAt : null,
    };
  }
  return {
    ok: true,
    wsPort: WS_PORT,
    httpPort: HTTP_PORT,
    wsState,
    profileCount: profiles.size,
    lastCommandTime,
    profileAges,
  };
}

function startHttp() {
  const ACTION_ALIAS = { tabs_list: 'list_tabs' };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${HTTP_PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, healthPayload());
    }

    if (req.method !== 'POST' || url.pathname !== '/') {
      return sendJson(res, req.method === 'POST' ? 404 : 405, {
        success: false,
        error: req.method === 'POST' ? 'not found' : 'method not allowed',
      });
    }

    try {
      const body = await readBody(req);
      const { action, profile, ...rest } = body || {};
      if (!action) {
        return sendJson(res, 400, { success: false, error: 'missing action' });
      }

      if (action === 'list_profiles') {
        return sendJson(res, 200, { profiles: listProfileObjects() });
      }

      if (action === 'chrome_bridge_health') {
        return sendJson(res, 200, healthPayload());
      }

      if (action === 'list_launchable_profiles') {
        return sendJson(res, 200, { profiles: listLaunchableProfiles() });
      }

      if (action === 'launch_profile') {
        const requestedProfile = String(profile || '').trim();
        if (!requestedProfile) {
          throw launchProfileError(400, 'profile is required');
        }

        const alreadyRunningProfileId = findConnectedProfile(requestedProfile);
        if (alreadyRunningProfileId) {
          return sendJson(res, 200, {
            success: true,
            alreadyRunning: true,
            profileId: alreadyRunningProfileId,
          });
        }

        const resolution = resolveLaunchableProfile(requestedProfile);
        if (!resolution.entry) {
          throw launchProfileError(400, `launchable profile ${resolution.error}: ${requestedProfile}`, {
            matches: (resolution.matches || []).map((entry) => ({
              dir: entry.dir,
              email: entry.email,
              name: entry.name,
              gaiaName: entry.gaiaName,
            })),
          });
        }

        const timeoutMs = Number.isFinite(Number(rest.timeoutMs))
          ? Math.max(0, Number(rest.timeoutMs))
          : DEFAULT_LAUNCH_TIMEOUT_MS;

        await spawnChromeProfile(resolution.entry.dir, rest.url);
        const launchedProfileId = await waitForLaunchedProfile(resolution.entry, requestedProfile, timeoutMs);
        if (launchedProfileId) {
          return sendJson(res, 200, {
            success: true,
            launched: true,
            profileId: launchedProfileId,
            dir: resolution.entry.dir,
          });
        }

        return sendJson(res, 200, {
          success: false,
          launched: true,
          dir: resolution.entry.dir,
          error: '起動したが拡張が時間内に接続しなかった。該当プロファイルに拡張が読み込まれているか確認してください',
        });
      }

      if (action === 'set_active_profile') {
        return sendJson(res, 400, {
          success: false,
          error: 'set_active_profile is handled by each MCP client session',
          profiles: listProfileObjects(),
        });
      }

      const pid = resolveProfile(profile);
      const resolvedAction = ACTION_ALIAS[action] || action;
      if (resolvedAction === 'evaluate' && rest.script === undefined && typeof rest.expression === 'string') {
        rest.script = rest.expression;
        delete rest.expression;
      }
      const result = await sendCommand(pid, { action: resolvedAction, ...rest }, commandTimeoutMs(resolvedAction));
      return sendJson(res, 200, { profileId: pid, ...result });
    } catch (e) {
      if (e?.payload) return sendJson(res, e.status || 400, e.payload);
      if (isTemporaryDisconnectionError(e)) {
        return sendJson(res, 503, { success: false, error: TEMPORARY_DISCONNECT_ERROR });
      }
      return sendJson(res, 500, { success: false, error: e?.message || String(e) });
    }
  });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (ALLOW_PORT_TAKEOVER) {
          log(`HTTP port ${HTTP_PORT} in use, killing holder...`);
          killPortHolder(HTTP_PORT);
        } else {
          log(`HTTP port ${HTTP_PORT} in use, waiting for holder to exit...`);
        }
        setTimeout(() => resolve(startHttp()), 1500);
      } else {
        log('http error:', err.message);
      }
    });
    server.listen(HTTP_PORT, HOST, () => {
      log(`HTTP bridge ready on http://${HOST}:${HTTP_PORT}`);
      resolve(server);
    });
  });
}

await startWss();
await startHttp();
log('hub ready');
await new Promise(() => {});
