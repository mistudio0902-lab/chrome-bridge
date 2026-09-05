import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const WS_PORT = 9339;
const HTTP_PORT = 9340;
const HOST = '127.0.0.1';

const children = [];
const sockets = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnNode(script, env = {}) {
  const child = spawn(process.execPath, [join(root, script)], {
    cwd: root,
    env: {
      ...process.env,
      CHROME_BRIDGE_WS_PORT: String(WS_PORT),
      CHROME_BRIDGE_HTTP_PORT: String(HTTP_PORT),
      CHROME_BRIDGE_HUB_HOST: HOST,
      CHROME_BRIDGE_TAKEOVER: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderrText = '';
  child.stdoutText = '';
  child.stderr.on('data', (chunk) => {
    child.stderrText += chunk.toString('utf8');
  });
  child.stdout.on('data', (chunk) => {
    child.stdoutText += chunk.toString('utf8');
  });
  children.push(child);
  return child;
}

function httpPost(body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = request({
      host: HOST,
      port: HTTP_PORT,
      method: 'POST',
      path: '/',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const payload = raw ? JSON.parse(raw) : {};
        if ((res.statusCode || 0) >= 400) {
          const error = new Error(payload.error || `HTTP ${res.statusCode}`);
          error.payload = payload;
          reject(error);
        } else {
          resolve(payload);
        }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('HTTP timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

async function waitForHubReady(hub) {
  for (let i = 0; i < 50; i += 1) {
    if (hub.exitCode !== null) {
      throw new Error(`hub exited early: ${hub.exitCode}\n${hub.stderrText}`);
    }
    try {
      await httpPost({ action: 'chrome_bridge_health' });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`hub did not become ready\n${hub.stderrText}`);
}

function connectFakeExtension(alias) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${WS_PORT}`);
    const timer = setTimeout(() => reject(new Error(`timeout connecting fake extension ${alias}`)), 5000);

    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({
        type: 'hello',
        alias,
        profileId: alias,
        email: `${alias}@example.test`,
        profileName: alias,
        ts: Date.now(),
      }));
      resolve(ws);
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      }
      if (msg.type === 'command') {
        const action = msg.command?.action;
        ws.send(JSON.stringify({
          type: 'result',
          id: msg.id,
          result: {
            success: true,
            pong: action === 'ping' ? true : undefined,
            action,
            profileId: alias,
          },
        }));
      }
    });

    ws.on('error', reject);
    sockets.push(ws);
  });
}

async function waitForProfiles(expected) {
  for (let i = 0; i < 50; i += 1) {
    const result = await httpPost({ action: 'list_profiles' }).catch(() => null);
    const ids = new Set((result?.profiles || []).map((p) => p.profileId));
    if (expected.every((id) => ids.has(id))) return result.profiles;
    await delay(100);
  }
  throw new Error(`profiles not connected: ${expected.join(', ')}`);
}

function createMcpClient(label, profile) {
  const child = spawnNode('server.js', { CHROME_BRIDGE_PROFILE: profile });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message.id || !pending.has(message.id)) continue;
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });

  child.on('exit', (code) => {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(`${label} exited with ${code}; pending id=${id}\n${child.stderrText}`));
    }
    pending.clear();
  });

  function send(method, params = {}, timeoutMs = 8000) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(JSON.stringify(message) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label} timeout waiting for ${method}\n${child.stderrText}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async function init() {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: `multiprofile-${label}`, version: '0.1.0' },
    });
    notify('notifications/initialized');
  }

  async function callTool(name, args = {}) {
    const result = await send('tools/call', { name, arguments: args });
    if (result?.isError) {
      const text = result.content?.find((item) => item.type === 'text')?.text || '{}';
      throw new Error(`${label} ${name} failed: ${text}`);
    }
    return result;
  }

  function close() {
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill();
    } catch {}
  }

  return { child, init, callTool, close };
}

function parseTextContent(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.ok(text, 'expected text content');
  return JSON.parse(text);
}

async function main() {
  const hub = spawnNode('hub.js');
  await waitForHubReady(hub);

  await Promise.all([
    connectFakeExtension('alphaTEST'),
    connectFakeExtension('betaTEST'),
  ]);
  await waitForProfiles(['alphaTEST', 'betaTEST']);

  const alpha = createMcpClient('alpha-client', 'alphaTEST');
  const mi = createMcpClient('beta-client', 'betaTEST');
  await Promise.all([alpha.init(), mi.init()]);

  const alphaPing = parseTextContent(await alpha.callTool('ping'));
  const miPing = parseTextContent(await mi.callTool('ping'));
  assert.equal(alphaPing.profileId, 'alphaTEST');
  assert.equal(miPing.profileId, 'betaTEST');

  const alphaProfiles = parseTextContent(await alpha.callTool('list_profiles'));
  const profileIds = new Set((alphaProfiles.profiles || []).map((p) => p.profileId));
  assert.ok(profileIds.has('alphaTEST'), 'alphaTEST should be listed');
  assert.ok(profileIds.has('betaTEST'), 'betaTEST should be listed');
  assert.equal(alphaProfiles.targetProfile, 'alphaTEST');

  const setAlpha = parseTextContent(await alpha.callTool('set_active_profile', { profile: 'betaTEST' }));
  assert.equal(setAlpha.targetProfile, 'betaTEST');
  assert.equal(parseTextContent(await alpha.callTool('ping')).profileId, 'betaTEST');
  assert.equal(parseTextContent(await mi.callTool('ping')).profileId, 'betaTEST');

  const setMi = parseTextContent(await mi.callTool('set_active_profile', { profile: 'alphaTEST' }));
  assert.equal(setMi.targetProfile, 'alphaTEST');
  assert.equal(parseTextContent(await mi.callTool('ping')).profileId, 'alphaTEST');
  assert.equal(parseTextContent(await alpha.callTool('ping')).profileId, 'betaTEST');

  alpha.close();
  mi.close();

  console.log('PASS multiprofile hub/thin-client isolation');
}

try {
  await main();
} catch (error) {
  console.error('FAIL multiprofile hub/thin-client isolation');
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
} finally {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {}
    }
  }
}
