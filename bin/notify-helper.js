#!/usr/bin/env node
// Tiny helper for Codex notify hook.
// Usage: node notify-helper.js <port> <json-payload>
// Codex appends the JSON payload as the last argv argument.
// Port is passed as the first argument by the notify config.

const { requestHook } = require('./hook-url');

const port = parseInt(process.argv[2], 10);
const raw = process.argv[process.argv.length - 1];
const clideckId = process.env.CLIDECK_SESSION_ID || '';
if (!port || !raw || raw === String(port)) process.exit(0);

let payload = raw;
try {
  const parsed = JSON.parse(raw);
  payload = JSON.stringify({ ...parsed, clideck_id: clideckId || undefined });
} catch {}

const req = requestHook('/hook/codex/stop', port, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  timeout: 2000,
});
req.on('error', () => {});
req.end(payload);
