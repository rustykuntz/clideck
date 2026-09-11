#!/usr/bin/env node

const { requestHook } = require('./hook-url');

// Accept the previous arguments for terminals that were already running when
// CliDeck was updated. New launches keep their hook definitions stable.
const legacy = /^\d+$/.test(process.argv[2] || '');
const port = Number(legacy ? process.argv[2] : process.env.CLIDECK_PORT);
const route = process.argv[legacy ? 3 : 2];
const hookToken = legacy ? process.argv[4] : process.env.CLIDECK_HOOK_TOKEN;
const sessionId = process.env.CLIDECK_NEXT_SESSION_ID;
if (!port || !route || !sessionId) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 100 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  const request = requestHook(`/hooks/${sessionId}/${route}`, port, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(input || '{}'),
      'X-Clideck-Launch': hookToken || '',
    },
    timeout: 2000,
  });
  request.on('error', () => {});
  request.end(input || '{}');
});
process.stdin.resume();
