const { randomUUID } = require('crypto');

// An agent's speak request waits for ONE browser to read it to the end (the CLI allows an hour).
// The reading browser checks in every 20 s, so a closed or reloaded window fails fast instead.
const CLAIM_MS = 5_000;
const IDLE_MS = 90_000;
const DEADLINE_MS = 55 * 60_000;
const MAX_MESSAGE = 300;
const NO_BROWSER = 'No open CliDeck window is showing this session, so nothing was read aloud. '
  + 'Open the session in CliDeck and try again.';
const TIMED_OUT = 'Speech did not finish within 55 minutes, so it was stopped.';
const WENT_AWAY = 'The CliDeck window reading this stopped responding (closed or reloaded?).';

function settings(api) {
  return {
    voice: api.getSetting('voice'),
    shortcut: api.getSetting('shortcut'),
    language: api.getSetting('language'),
    normalization: api.getSetting('normalization'),
    quality: api.getSetting('quality'),
    playbackRate: Number(api.getSetting('playback-rate')) || 1,
  };
}

function speechText(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Provide text to read.');
  return text;
}

function failure(message) {
  return { stdout: '', stderr: `Supertonic: ${message}\n`, exitCode: 1 };
}

exports.activate = (api) => {
  const requests = new Map();
  const finish = (requestId, result) => {
    const request = requests.get(requestId);
    if (!request) return;
    requests.delete(requestId);
    clearTimeout(request.timer);
    clearTimeout(request.idle);
    request.resolve(result);
  };

  api.registerCommand('speak', ({ args, stdin, sessionId }) => {
    const text = speechText(args.join(' ').trim() || stdin);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      requests.set(requestId, {
        resolve, claim: '', timer: setTimeout(() => finish(requestId, failure(NO_BROWSER)), CLAIM_MS),
      });
      // Its own event name: an older client that cannot report back never plays it.
      api.sendToClients('speak-request', { text, sessionId, requestId });
    });
  });

  // Every browser showing the session asks; only the first one plays, so two windows never
  // both speak and the agent gets exactly one answer. The claim token goes only to the winner.
  api.onClientMessage('speak-claim', (data, context) => {
    const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
    const request = requests.get(requestId);
    const granted = Boolean(request && !request.claim);
    if (granted) {
      request.claim = randomUUID();
      clearTimeout(request.timer);
      request.timer = setTimeout(() => giveUp(requestId, TIMED_OUT), DEADLINE_MS);
      request.idle = setTimeout(() => giveUp(requestId, WENT_AWAY), IDLE_MS);
    }
    context.reply('speak-claim', { requestId, granted, ...(granted ? { claim: request.claim } : {}) });
  });

  const claimed = (data) => {
    const request = requests.get(typeof data?.requestId === 'string' ? data.requestId : '');
    return request?.claim && data.claim === request.claim ? request : null;
  };
  const giveUp = (requestId, message) => {
    api.sendToClients('speak-cancel', { requestId }); // the reading browser stops its own playback
    finish(requestId, failure(message));
  };

  api.onClientMessage('speak-alive', (data) => {
    const request = claimed(data);
    if (!request) return;
    clearTimeout(request.idle);
    request.idle = setTimeout(() => giveUp(data.requestId, WENT_AWAY), IDLE_MS);
  });

  api.onClientMessage('speak-result', (data) => {
    if (!claimed(data)) return;
    if (data.status === 'finished') finish(data.requestId, 'Read aloud in CliDeck.\n');
    else if (data.status === 'failed') {
      const message = String(data.message || '').trim().slice(0, MAX_MESSAGE);
      finish(data.requestId, failure(message || 'Speech failed in CliDeck.'));
    }
  });

  api.onClientMessage('ready', (_data, context) => {
    context.reply('settings', settings(api));
  });

  api.onSettingsChange(() => api.sendToClients('settings', settings(api)));

  // A completion belongs only to the browser that requested it, never every client.
  api.onClientMessage('auto-read-result', (data, context) => {
    if (typeof data?.token === 'string' && data.token.length <= 200
      && ['deferred', 'finished', 'failed'].includes(data.status)) {
      context.reply('auto-read-result', { token: data.token, status: data.status });
    }
  });
};
