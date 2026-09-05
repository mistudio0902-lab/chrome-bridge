import { request } from 'node:http';
import { readFileSync } from 'node:fs';

const [toolName, ...argParts] = process.argv.slice(2);
if (!toolName) {
  console.error('Usage: node call.mjs <tool_name> [json_args | key=value ...]');
  process.exit(2);
}

const HTTP_PORT = Number.parseInt(process.env.CHROME_BRIDGE_HTTP_PORT || '9240', 10);
const HUB_HOST = process.env.CHROME_BRIDGE_HUB_HOST || '127.0.0.1';
const HUB_UNREACHABLE_MESSAGE = 'ハブ未起動(PM2 chrome-bridge-v3を確認)';

function parseValue(value) {
  if (value.startsWith('@')) return readFileSync(value.slice(1), 'utf8');
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value;
}

function parseArgs(parts) {
  const argsText = parts.join(' ').trim();
  if (!argsText) return {};

  try {
    return JSON.parse(argsText);
  } catch {
    const parsed = {};
    for (const part of parts) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const key = part.slice(0, index);
      const value = part.slice(index + 1);
      parsed[key] = parseValue(value);
    }
    return parsed;
  }
}

function hubPost(body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = request({
      host: HUB_HOST,
      port: HTTP_PORT,
      method: 'POST',
      path: '/',
      timeout: 95000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      },
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
          const error = new Error(payload?.error || `HTTP ${res.statusCode}`);
          error.status = res.statusCode;
          error.payload = payload;
          reject(error);
        } else {
          resolve(payload);
        }
      });
    });

    req.on('timeout', () => req.destroy(Object.assign(new Error('hub request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

const toolArgs = parseArgs(argParts);
// `expression` is the public evaluate parameter. Keep `script` accepted for
// existing callers, but normalize before sending so the extension never sees
// an undefined script argument.
if (toolName === 'evaluate' && toolArgs.script === undefined && typeof toolArgs.expression === 'string') {
  toolArgs.script = toolArgs.expression;
  delete toolArgs.expression;
}
if (!toolArgs.profile && process.env.CHROME_BRIDGE_PROFILE) {
  toolArgs.profile = process.env.CHROME_BRIDGE_PROFILE;
}

try {
  const result = await hubPost({ action: toolName, ...toolArgs });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(error?.code)) {
    console.error(HUB_UNREACHABLE_MESSAGE);
  } else if (error?.payload) {
    console.error(JSON.stringify(error.payload, null, 2));
  } else {
    console.error(error?.message || String(error));
  }
  process.exit(1);
}
