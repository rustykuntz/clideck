const assert = require('assert');
const { ScreenCapture, latestAgentText } = require('../server-capture');

function includesLine(lines, expected) {
  assert(lines.includes(expected), `expected line "${expected}" in:\n${lines.join('\n')}`);
}

{
  const cap = new ScreenCapture(80, 8);
  cap.write('Working...\r\x1b[KDone\r\n');
  includesLine(cap.lines(), 'Done');
  assert(!cap.lines().includes('Working...'), 'carriage-return rewrite should remove stale text after erase-line');
}

{
  const cap = new ScreenCapture(80, 8);
  cap.write('› Reply with exactly READY\r\n');
  cap.write('• READY\r\n');
  includesLine(cap.lines(), '› Reply with exactly READY');
  includesLine(cap.lines(), '• READY');
  assert.strictEqual(latestAgentText('codex', cap.lines()), 'READY');
}

{
  const cap = new ScreenCapture(20, 3);
  cap.write('one\r\ntwo\r\nthree\r\nfour\r\n');
  const lines = cap.lines();
  includesLine(lines, 'one');
  includesLine(lines, 'four');
}

console.log('server-capture: PASS');
