#!/usr/bin/env node

const { requestHook } = require('./hook-url');

const port = Number(process.argv[2]);
const sessionId = process.argv[3];
const route = process.argv[4];
if (!port || !sessionId || !route) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const request = requestHook(`/hooks/${sessionId}/${route}`, port, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(input),
    },
    timeout: 2000,
  }, process.argv[5] || process.env.CLIDECK_URL);
  request.on('error', () => {});
  request.end(input || '{}');
});
process.stdin.resume();
