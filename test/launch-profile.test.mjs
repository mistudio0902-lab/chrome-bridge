import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const WS_PORT = 9341;
const HTTP_PORT = 9342;
const HOST = '127.0.0.1';

const children = [];
const tempRoot = join(tmpdir(), `chrome-bridge-launch-profile-${process.pid}`);
const userDataDir = join(tempRoot, 'User Data');
const fakeChromeScript = join(tempRoot, 'fake-chrome.mjs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnHub() {
  const child = spawn(process.execPath, [join(root, 'hub.js')], {
    cwd: root,
    env: {
      ...process.env,
      CHROME_BRIDGE_WS_PORT: String(WS_PORT),
      CHROME_BRIDGE_HTTP_PORT: String(HTTP_PORT),
      CHROME_BRIDGE_HUB_HOST: HOST,
      CHROME_BRIDGE_TAKEOVER: '0',
      CHROME_BRIDGE_USER_DATA_DIR: userDataDir,
      CHROME_BRIDGE_CHROME_EXE: process.execPath,
      CHROME_BRIDGE_CHROME_EXE_ARGS: JSON.stringify([fakeChromeScript]),
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

function httpPost(body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = request({
      host: HOST,
      port: HTTP_PORT,
      method: 'POST',
      path: '/',
      timeout: timeoutMs,
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
          error.status = res.statusCode;
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
      await httpPost({ action: 'chrome_bridge_health' }, 1000);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`hub did not become ready\n${hub.stderrText}`);
}

function writeFixtures() {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(join(userDataDir, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        'Profile TESTDIR': {
          user_name: 'launchtest@example.test',
          name: 'LaunchTest',
          gaia_name: 'Launch Test',
        },
      },
    },
  }), 'utf8');

  const packageJsonUrl = pathToFileURL(join(root, 'package.json')).href;
  writeFileSync(fakeChromeScript, `
import { createRequire } from 'node:module';

const require = createRequire(${JSON.stringify(packageJsonUrl)});
const WebSocket = require('ws');

const profileArg = process.argv.find((arg) => arg.startsWith('--profile-directory='));
const dir = profileArg ? profileArg.slice('--profile-directory='.length) : '';
const profiles = {
  'Profile TESTDIR': {
    email: 'launchtest@example.test',
    profileId: 'launchtest@example.test',
    profileName: 'LaunchTest',
  },
};
const info = profiles[dir];
if (!info) process.exit(2);

const port = process.env.CHROME_BRIDGE_WS_PORT || '9341';
const ws = new WebSocket('ws://127.0.0.1:' + port);
const exitTimer = setTimeout(() => process.exit(3), 30000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'hello',
    email: info.email,
    profileId: info.profileId,
    profileName: info.profileName,
    ts: Date.now(),
  }));
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
  }
});

ws.on('close', () => {
  clearTimeout(exitTimer);
  process.exit(0);
});
`, 'utf8');
}

async function main() {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  writeFixtures();

  const hub = spawnHub();
  await waitForHubReady(hub);

  const launch = await httpPost({
    action: 'launch_profile',
    profile: 'launchtest@example.test',
    timeoutMs: 8000,
  }, 12000);
  assert.equal(launch.success, true);
  assert.equal(launch.launched, true);
  assert.equal(launch.profileId, 'launchtest@example.test');
  assert.equal(launch.dir, 'Profile TESTDIR');

  const alreadyRunning = await httpPost({
    action: 'launch_profile',
    profile: 'LaunchTest',
    timeoutMs: 1000,
  });
  assert.equal(alreadyRunning.success, true);
  assert.equal(alreadyRunning.alreadyRunning, true);
  assert.equal(alreadyRunning.profileId, 'launchtest@example.test');

  const launchable = await httpPost({ action: 'list_launchable_profiles' });
  const profile = (launchable.profiles || []).find((item) => item.dir === 'Profile TESTDIR');
  assert.ok(profile, 'Profile TESTDIR should be listed');
  assert.equal(profile.email, 'launchtest@example.test');
  assert.equal(profile.name, 'LaunchTest');
  assert.equal(profile.connected, true);

  await assert.rejects(
    () => httpPost({ action: 'launch_profile', profile: 'missing@example.test', timeoutMs: 1000 }),
    (error) => {
      assert.equal(error.status, 400);
      assert.ok(Array.isArray(error.payload?.launchableProfiles));
      return true;
    },
  );

  console.log('PASS launch_profile starts and connects profile');
}

try {
  await main();
} catch (error) {
  console.error('FAIL launch_profile starts and connects profile');
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {}
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
