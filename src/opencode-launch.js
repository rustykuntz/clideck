const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { pathToFileURL } = require('url');

const PLUGIN_SOURCE = `
const env = globalThis.process?.env || {};
const endpoint = (route) => new URL(\`/hooks/\${env.CLIDECK_NEXT_SESSION_ID}/\${route}\`, env.CLIDECK_URL || \`http://127.0.0.1:\${env.CLIDECK_NEXT_PORT}\`).href;
let primarySession = '';
let latestText = '';
let currentModel = null;
let providerClient = null;
let providersPromise = null;

async function post(route, payload = {}) {
  try {
    await fetch(endpoint(route), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

async function contextWindow() {
  if (!providerClient || !currentModel) return 0;
  if (!providersPromise) providersPromise = providerClient.provider.list().catch(() => null);
  const response = await providersPromise;
  const data = response?.data || response || {};
  const providers = data.all || data.providers || [];
  const provider = providers.find?.((item) => item?.id === currentModel.providerID);
  return Number(provider?.models?.[currentModel.modelID]?.limit?.context || 0);
}

export const CliDeckNextBridge = async ({ client }) => {
  providerClient = client;
  await post('session-start');
  return { event: async ({ event }) => {
    const properties = event?.properties || {};
    const sessionID = properties.sessionID || properties.info?.id || properties.part?.sessionID || '';
    if (!primarySession && sessionID && (
      event?.type === 'session.created'
      || (event?.type === 'message.updated' && properties.info?.role === 'user')
      || (event?.type === 'session.status' && properties.status?.type === 'busy')
    )) {
      primarySession = sessionID;
      await post('session-start', { session_id: sessionID });
      if (event?.type === 'session.created') await post('idle', { session_id: sessionID });
    }
    if (!primarySession || sessionID !== primarySession) return;

    if (event.type === 'message.updated' && properties.info?.role === 'user') latestText = '';
    if (event.type === 'message.updated' && properties.info?.role === 'assistant') {
      currentModel = {
        providerID: properties.info.providerID || '',
        modelID: properties.info.modelID || '',
      };
    }
    if (event.type === 'message.part.updated') {
      const part = properties.part || {};
      if (part.type === 'text' && part.time) latestText = part.text || '';
      if (part.type === 'step-finish') {
        const windowTokens = await contextWindow();
        const tokens = part.tokens || {};
        const usedTokens = Number(tokens.total ?? (
          Number(tokens.input || 0)
          + Number(tokens.output || 0)
          + Number(tokens.reasoning || 0)
          + Number(tokens.cache?.read || 0)
          + Number(tokens.cache?.write || 0)
        ));
        if (usedTokens >= 0 && windowTokens > 0) {
          await post('context', {
            context_usage: { used_tokens: usedTokens, window_tokens: windowTokens },
          });
        }
      }
    }
    if (event.type === 'session.status' && properties.status?.type === 'busy') {
      await post('start', { session_id: primarySession });
    }
    if ((event.type === 'session.status' && properties.status?.type === 'idle')
      || event.type === 'session.idle') {
      await post('stop', {
        session_id: primarySession,
        last_assistant_message: latestText,
      });
    }
  } };
};
`;

function createOpenCodeLaunch({ command = 'opencode', port, sessionId, resumeHandle, agentGuide }) {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-next-opencode-'));
  const pluginPath = join(dir, 'bridge.js');
  const configPath = join(dir, 'opencode.json');
  const guidePath = join(dir, 'CLIDECK.md');
  writeFileSync(pluginPath, PLUGIN_SOURCE, { mode: 0o600 });
  if (agentGuide) writeFileSync(guidePath, agentGuide, { mode: 0o600 });
  writeFileSync(configPath, `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugin: [pathToFileURL(pluginPath).href],
    ...(agentGuide && { instructions: [guidePath] }),
  }, null, 2)}\n`, { mode: 0o600 });

  return {
    command,
    args: resumeHandle ? ['--session', resumeHandle] : [],
    env: {
      OPENCODE_CONFIG: configPath,
      CLIDECK_NEXT_PORT: String(port),
      CLIDECK_NEXT_SESSION_ID: sessionId,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { createOpenCodeLaunch };
