#!/usr/bin/env node
// Silent Codex lifecycle hook for CliDeck.
// Reads Codex hook JSON from stdin, posts to CliDeck, and intentionally prints nothing.

const { requestHook } = require('./hook-url');

const port = parseInt(process.argv[2], 10);
const route = String(process.argv[3] || '').replace(/[^a-z]/g, '');
const clideckId = process.env.CLIDECK_SESSION_ID || '';
if (!port || !route) process.exit(0);

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  body += chunk;
  if (body.length > 1e6) process.exit(0);
});
process.stdin.on('end', () => {
  let payload = {};
  try { payload = body.trim() ? JSON.parse(body) : {}; } catch {}
  payload.clideck_id = clideckId || undefined;
  payload.source = 'hook';

  const req = requestHook(`/hook/codex/${route}`, port, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 2000,
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(JSON.stringify(payload));
});
