#!/usr/bin/env node

const { requestHook } = require('./hook-url');

const port = parseInt(process.argv[2], 10);
const route = process.argv[3];
if (!port || !route) process.exit(0);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  let hook = {};
  try { hook = stdin ? JSON.parse(stdin) : {}; } catch {}
  const body = JSON.stringify({
    clideck_id: process.env.CLIDECK_SESSION_ID || '',
    session_id: hook.session_id || '',
    hook_event_name: hook.hook_event_name || '',
    source: hook.source || '',
    reason: hook.reason || '',
    payload: stdin.trim() || undefined,
  });
  const req = requestHook(`/hook/claude/${route}`, port, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 2000,
  });
  req.on('error', () => {});
  req.end(body);
});
process.stdin.resume();
