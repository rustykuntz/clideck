const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const EXTENSION_SOURCE = `
const env = globalThis.process?.env || {};
const endpoint = (route) => new URL(\`/hooks/\${env.CLIDECK_NEXT_SESSION_ID}/\${route}\`, env.CLIDECK_URL || \`http://127.0.0.1:\${env.CLIDECK_NEXT_PORT}\`).href;

async function post(route, payload = {}) {
  try {
    await fetch(endpoint(route), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

function metadata(ctx) {
  return {
    session_id: ctx.sessionManager.getSessionId() || '',
    transcript_path: ctx.sessionManager.getSessionFile() || '',
  };
}

function contextUsage(ctx) {
  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens == null || !usage.contextWindow) return null;
  return {
    used_tokens: usage.tokens,
    window_tokens: usage.contextWindow,
    percent: usage.percent,
    estimated: true,
  };
}

function finalText(messages = []) {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  return (assistant?.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('\\n')
    .trim();
}

export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    await post('session-start', metadata(ctx));
    const usage = contextUsage(ctx);
    if (usage) await post('context', { context_usage: usage });
    await post('idle', metadata(ctx));
  });
  pi.on('agent_start', async (_event, ctx) => {
    await post('start', metadata(ctx));
  });
  pi.on('message_end', async (_event, ctx) => {
    const usage = contextUsage(ctx);
    if (usage) await post('context', { context_usage: usage });
  });
  pi.on('agent_end', async (event, ctx) => {
    const usage = contextUsage(ctx);
    if (usage) await post('context', { context_usage: usage });
    await post('stop', { ...metadata(ctx), last_assistant_message: finalText(event.messages) });
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    await post('session-end', metadata(ctx));
  });
}
`;

function createPiLaunch({
  command = 'pi', port, sessionId, resumeHandle, providerName, model, agentGuide,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-next-pi-'));
  const extensionPath = join(dir, 'bridge.ts');
  writeFileSync(extensionPath, EXTENSION_SOURCE, { mode: 0o600 });
  const args = [];
  if (providerName) args.push('--provider', providerName);
  if (model) args.push('--model', model);
  if (agentGuide) args.push('--append-system-prompt', agentGuide);
  args.push('--extension', extensionPath);
  if (resumeHandle) args.push('--session', resumeHandle);
  return {
    command,
    args,
    env: {
      CLIDECK_NEXT_PORT: String(port),
      CLIDECK_NEXT_SESSION_ID: sessionId,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { createPiLaunch };
