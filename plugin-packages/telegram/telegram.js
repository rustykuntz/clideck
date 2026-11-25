// The optional Telegram plugin uses outbound HTTPS only.
class TelegramError extends Error {
  constructor(message, { retryAfter = 0, uncertain = false, code = 0 } = {}) {
    super(message); this.retryAfter = retryAfter; this.uncertain = uncertain; this.code = code;
  }
}

class Telegram {
  constructor(token, { fetch: request = fetch } = {}) { this.token = token; this.fetch = request; }
  async call(method, body = {}, { signal, timeoutMs = 15_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw Error('Response too large.');
        chunks.push(Buffer.from(chunk));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result?.ok) throw new TelegramError(String(result?.description || `Telegram returned HTTP ${response.status}.`)
        .replaceAll(this.token, '[token]').slice(0, 1000), {
        retryAfter: Math.max(0, Math.min(3600, Number(result?.parameters?.retry_after) || 0)), code: result?.error_code || response.status,
      });
      return result.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      // fetch errors may include the credential-bearing URL. Never propagate them.
      throw new TelegramError('Telegram did not confirm the request. Check the connection before retrying.', { uncertain: true });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}

function messageParts(value) {
  // Telegram's text limit is 4096 characters. Leave room for surrogate pairs.
  const chars = Array.from(String(value)); const parts = [];
  for (let i = 0; i < chars.length; i += 2000) parts.push(chars.slice(i, i + 2000).join(''));
  return parts.length ? parts : ['(No text reply.)'];
}

module.exports = { Telegram, TelegramError, messageParts };
