import { request } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HTTP_PORT = Number.parseInt(process.env.CHROME_BRIDGE_HTTP_PORT || '9240', 10);
const HUB_HOST = process.env.CHROME_BRIDGE_HUB_HOST || '127.0.0.1';
const HUB_UNREACHABLE_MESSAGE = 'ハブ未起動(PM2 chrome-bridge-v3を確認)';
const TEMPORARY_DISCONNECT_ERROR = 'extension temporarily disconnected, retry in 5s';
const DEFAULT_HUB_TIMEOUT_MS = 95000;

let targetProfile = (process.env.CHROME_BRIDGE_PROFILE || '').trim() || null;

function log(...a) {
  process.stderr.write('[bridge-mcp] ' + a.join(' ') + '\n');
}

process.on('uncaughtException', (e) => log('uncaughtException:', e?.stack || e?.message || e));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.stack || e?.message || e));

class HubHttpError extends Error {
  constructor(status, payload) {
    super(payload?.error || `hub returned HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

class HubUnavailableError extends Error {
  constructor(cause) {
    super(HUB_UNREACHABLE_MESSAGE);
    this.cause = cause;
  }
}

class ProfileRequiredError extends Error {
  constructor(payload) {
    super(payload.error);
    this.payload = payload;
  }
}

function isHubUnavailableError(e) {
  return e instanceof HubUnavailableError
    || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(e?.code);
}

function isTemporaryDisconnectionError(e) {
  const msg = String(e?.message || e?.payload?.error || e || '');
  return e?.status === 503
    || msg.includes(TEMPORARY_DISCONNECT_ERROR)
    || msg.includes('WebSocket is not open');
}

function hubRequest(method, path, body = null, timeoutMs = DEFAULT_HUB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const json = body ? JSON.stringify(body) : null;
    const req = request({
      host: HUB_HOST,
      port: HTTP_PORT,
      method,
      path,
      timeout: timeoutMs,
      headers: json ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          payload = { success: false, error: raw || `HTTP ${res.statusCode}` };
        }
        if ((res.statusCode || 0) >= 400) {
          reject(new HubHttpError(res.statusCode || 500, payload));
        } else {
          resolve(payload);
        }
      });
    });

    req.on('timeout', () => req.destroy(Object.assign(new Error('hub request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(isHubUnavailableError(e) ? new HubUnavailableError(e) : e));
    if (json) req.write(json);
    req.end();
  });
}

function hubPost(action, args = {}) {
  return hubRequest('POST', '/', { action, ...args });
}

function textResponse(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function temporaryDisconnectResponse() {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: TEMPORARY_DISCONNECT_ERROR }) }],
  };
}

function matchProfile(profile, profiles = []) {
  const requested = String(profile || '').trim();
  if (!requested) return null;
  if (profiles.some((p) => p.profileId === requested)) return requested;
  const matches = profiles
    .map((p) => p.profileId)
    .filter((id) => id && (id.includes(requested) || requested.includes(id)));
  return matches.length === 1 ? matches[0] : null;
}

async function connectedProfilesPayload(error) {
  const list = await hubPost('list_profiles');
  return {
    success: false,
    error,
    targetProfile,
    profiles: list.profiles || [],
  };
}

async function resolveProfile(args = {}) {
  const explicit = String(args.profile || '').trim();
  if (explicit) return explicit;
  if (targetProfile) return targetProfile;
  throw new ProfileRequiredError(await connectedProfilesPayload('profile is required. pass profile or set CHROME_BRIDGE_PROFILE/set_active_profile.'));
}

const P = { type: 'string', description: 'profile email or alias (omit = active)' };

const TOOLS = [
  { name: 'detach_debugger', description: 'Detach a stalled Chrome debugger session from a tab so it can recover.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'list_launchable_profiles', description: 'List Chrome profiles from Local State that can be launched', inputSchema: { type: 'object', properties: {} } },
  { name: 'launch_profile', description: 'Launch a Chrome profile and wait for the extension to connect', inputSchema: { type: 'object', properties: { profile: { type: 'string' }, url: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['profile'] } },
  { name: 'list_profiles', description: '接続中プロファイル一覧', inputSchema: { type: 'object', properties: {} } },
  { name: 'set_active_profile', description: 'アクティブプロファイル設定', inputSchema: { type: 'object', properties: { profile: { type: 'string' } }, required: ['profile'] } },

  { name: 'tabs_list',    description: 'タブ一覧',        inputSchema: { type: 'object', properties: { profile: P } } },
  { name: 'tabs_create',  description: '新規タブ',        inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' }, profile: P } } },
  { name: 'tabs_close',   description: 'タブを閉じる',    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P }, required: ['tabId'] } },
  { name: 'tabs_select',  description: 'タブをアクティブ化', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P }, required: ['tabId'] } },
  { name: 'tab_context',  description: '現在タブのURL/title', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'cdp',          description: '対象タブへ任意の CDP コマンドを送信', inputSchema: { type: 'object', properties: { method: { type: 'string', description: 'CDP method, e.g. Emulation.setFocusEmulationEnabled' }, params: { type: 'string', description: 'JSON object string of CDP parameters' }, tabId: { type: 'number' }, profile: P }, required: ['method'] } },
  { name: 'ensure_visible', description: '対象タブを復元・前面化し、CDP focus emulation で操作可能化', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },

  { name: 'navigate',     description: 'URL移動',         inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' }, profile: P }, required: ['url'] } },
  { name: 'back',         description: '戻る',            inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'forward',      description: '進む',            inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'reload',       description: 'リロード',        inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'wait_for',     description: 'selector/text待機', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'number' }, tabId: { type: 'number' }, profile: P } } },

  { name: 'screenshot',   description: 'PNG取得',         inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'read_page',    description: 'ページHTML',      inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'get_page_text',description: 'ページtext',      inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, profile: P } } },
  { name: 'snapshot',     description: 'インタラクティブ要素tree', inputSchema: { type: 'object', properties: { maxNodes: { type: 'number' }, tabId: { type: 'number' }, profile: P } } },
  { name: 'find',         description: '要素検索',        inputSchema: { type: 'object', properties: { text: { type: 'string' }, role: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'number' }, profile: P } } },
  { name: 'read_console_messages', description: 'コンソールログ', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, limit: { type: 'number' }, tabId: { type: 'number' }, profile: P } } },
  { name: 'read_network_requests', description: 'ネットワーク一覧', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, limit: { type: 'number' }, tabId: { type: 'number' }, profile: P } } },

  { name: 'click',        description: 'クリック',        inputSchema: { type: 'object', properties: { uid: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'number' }, profile: P } } },
  { name: 'real_click',   description: 'CDP 経由で信頼されたマウスクリックを送信', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string' }, nth: { type: 'number', minimum: 0 }, tabId: { type: 'number' }, profile: P }, anyOf: [{ required: ['x', 'y'] }, { required: ['selector'] }] } },
  { name: 'click_by_text',description: 'テキストでクリック', inputSchema: { type: 'object', properties: { tag: { type: 'string' }, text: { type: 'string' }, tabId: { type: 'number' }, profile: P }, required: ['text'] } },
  { name: 'hover',        description: 'ホバー',          inputSchema: { type: 'object', properties: { uid: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'number' }, profile: P } } },
  { name: 'type_text',    description: 'テキスト入力',    inputSchema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'number' }, profile: P }, required: ['text'] } },
  { name: 'real_type',    description: 'CDP Input.insertText による信頼されたテキスト入力', inputSchema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' }, nth: { type: 'number', minimum: 0 }, tabId: { type: 'number' }, profile: P }, required: ['text'] } },
  { name: 'fill',         description: 'input値セット',   inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' }, profile: P }, required: ['selector', 'value'] } },
  { name: 'set_select',   description: 'select値設定',    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' }, profile: P }, required: ['selector', 'value'] } },
  { name: 'press_key',    description: 'キーストローク',  inputSchema: { type: 'object', properties: { key: { type: 'string' }, tabId: { type: 'number' }, profile: P }, required: ['key'] } },
  { name: 'scroll',       description: 'スクロール',      inputSchema: { type: 'object', properties: { amount: { type: 'number' }, selector: { type: 'string' }, tabId: { type: 'number' }, profile: P } } },
  { name: 'evaluate',     description: 'JS実行',          inputSchema: { type: 'object', properties: { expression: { type: 'string' }, script: { type: 'string', description: 'Deprecated alias for expression' }, tabId: { type: 'number' }, profile: P }, anyOf: [{ required: ['expression'] }, { required: ['script'] }] } },
  { name: 'evaluate_debugger', description: 'CDP Runtime.evaluate で JS を実行', inputSchema: { type: 'object', properties: { script: { type: 'string' }, tabId: { type: 'number' }, profile: P }, required: ['script'] } },
  { name: 'upload_file',  description: 'ファイルアップロード', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, tabId: { type: 'number' }, profile: P }, required: ['selector', 'files'] } },
  { name: 'resize_window',description: 'ウィンドウサイズ変更', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, tabId: { type: 'number' }, profile: P }, required: ['width', 'height'] } },
  { name: 'gif_start',    description: 'GIF録画開始',     inputSchema: { type: 'object', properties: { intervalMs: { type: 'number' }, tabId: { type: 'number' }, profile: P } } },
  { name: 'ping',         description: '接続確認',        inputSchema: { type: 'object', properties: { profile: P } } },
  { name: 'chrome_bridge_health', description: 'chrome bridge health', inputSchema: { type: 'object', properties: {} } },
];

const mcpServer = new Server(
  { name: 'chrome-bridge', version: '3.1.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const { profile: _profile, ...rest } = args || {};

  try {
    if (name === 'list_profiles') {
      const result = await hubPost('list_profiles');
      return textResponse({ targetProfile, ...result });
    }

    if (name === 'list_launchable_profiles') {
      const result = await hubPost('list_launchable_profiles');
      return textResponse({ targetProfile, ...result });
    }

    if (name === 'chrome_bridge_health') {
      const result = await hubPost('chrome_bridge_health');
      return textResponse({ targetProfile, ...result });
    }

    if (name === 'launch_profile') {
      const result = await hubPost('launch_profile', args);
      if (result?.success !== false && result?.profileId) {
        targetProfile = result.profileId;
      }
      return textResponse({ targetProfile, ...result });
    }

    if (name === 'set_active_profile') {
      const requested = String(args.profile || '').trim();
      if (!requested) return textResponse({ success: false, error: 'profile is required', targetProfile }, true);

      let warning = null;
      try {
        const result = await hubPost('list_profiles');
        const matched = matchProfile(requested, result.profiles || []);
        targetProfile = matched || requested;
        if (!matched) warning = `profile is not currently connected: ${requested}`;
      } catch (e) {
        if (isHubUnavailableError(e)) {
          targetProfile = requested;
          warning = HUB_UNREACHABLE_MESSAGE;
        } else {
          throw e;
        }
      }

      return textResponse({ success: true, targetProfile, ...(warning ? { warning } : {}) });
    }

    const pid = await resolveProfile(args);
    const result = await hubPost(name, { profile: pid, ...rest });

    if (name === 'screenshot' && result?.data) {
      const base64 = String(result.data).split(',')[1] || result.data;
      return {
        content: [
          { type: 'image', data: base64, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ profileId: result.profileId || pid, success: true }) },
        ],
      };
    }

    return textResponse({ profileId: result.profileId || pid, ...result });
  } catch (e) {
    if (isTemporaryDisconnectionError(e)) return temporaryDisconnectResponse();
    if (e instanceof ProfileRequiredError) return textResponse(e.payload, true);
    if (isHubUnavailableError(e)) return textResponse({ success: false, error: HUB_UNREACHABLE_MESSAGE, targetProfile }, true);
    if (e instanceof HubHttpError) {
      return textResponse({ targetProfile, ...(e.payload || { success: false, error: e.message }) }, true);
    }
    return textResponse({ success: false, error: e?.message || String(e), targetProfile }, true);
  }
});

process.stdin.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
log('MCP ready');
