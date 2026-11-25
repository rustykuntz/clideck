'use strict';
// The page a person sees in their browser when a Google sign-in started from CliDeck comes back. The plugin
// serves it from its loopback callback only after gog reports the result, so "connected" is shown only for a
// stored sign-in. Standalone: inline CSS and SVG, system fonts, no scripts and no outside requests. It follows
// the browser's light/dark preference with CliDeck's own colours, and every dynamic value is escaped.

const GOG_URL = 'https://github.com/openclaw/gogcli';
const CLIDECK_URL = 'https://github.com/rustykuntz/clideck';

const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (value, max) => { const text = String(value == null ? '' : value).trim(); return text.length > max ? text.slice(0, max - 1) + '…' : text; };

const ICONS = {
  connected: '<path d="M7.5 12.5l3 3 6-7"/>',
  failed: '<path d="M12 7.5v5.5"/><path d="M12 16.4v.1"/>',
  cancelled: '<path d="M8.5 12h7"/>',
};
const MARK = '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><defs><linearGradient id="cd" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent-deep)"/></linearGradient></defs>'
  + '<rect width="24" height="24" rx="6.5" fill="url(#cd)"/><path d="M8 10l4 4 4-4" fill="none" style="stroke:var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/></svg>';
const EXTERNAL = '<svg class="ext" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/></svg>';

function content(status, email, message) {
  const who = email ? `<strong class="who">${escapeHtml(email)}</strong>` : 'Your Google account';
  if (status === 'connected') {
    return { tone: 'ok', title: 'You’re connected', heading: 'Google account connected',
      lead: `${who} is now connected to CliDeck.`,
      next: 'You can close this tab and go back to CliDeck.' };
  }
  if (status === 'cancelled') {
    // A cancel can race gog saving the token before its receipt arrives: never promise nothing was connected.
    return { tone: 'neutral', title: 'Sign-in stopped', heading: 'Sign-in stopped',
      lead: 'This Google sign-in was stopped.',
      next: 'Close this tab and check the connection in CliDeck before trying again.' };
  }
  // Anything that isn't a confirmed connection is shown as not finished — never as success.
  return { tone: 'bad', title: 'Sign-in didn’t finish', heading: 'Sign-in didn’t finish',
    lead: email ? `CliDeck couldn’t connect ${who}.` : 'CliDeck couldn’t connect your Google account.',
    detail: message,
    next: 'Close this tab, go back to CliDeck and try signing in again.' };
}

function renderOAuthPage({ status, email, message } = {}) {
  const state = status === 'connected' || status === 'cancelled' ? status : 'failed';
  const view = content(state, clip(email, 254), clip(message, 600));
  const detail = view.detail ? `<p class="detail"><span class="detail-label">What Google or CliDeck reported</span>${escapeHtml(view.detail)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(view.title)} · CliDeck</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#191a1e; --card:#212229; --inset:#292b33; --border:rgba(255,255,255,.08); --border-strong:rgba(255,255,255,.13);
    --text:#e9eaee; --dim:#a1a4ad; --faint:#7d8089;
    --accent:#e18063; --accent-deep:#c25a3c; --accent-ink:#1a0d09; --glow:rgba(225,128,99,.28);
    --ok:#74b98f; --bad:#e06a6a; --neutral:#a1a4ad; --shadow:rgba(0,0,0,.45);
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",Roboto,"Helvetica Neue",Arial,sans-serif;
    --mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg:#ebedf0; --card:#f6f7f9; --inset:#e7e9ed; --border:rgba(28,24,20,.10); --border-strong:rgba(28,24,20,.17);
      --text:#1b1c20; --dim:#5c5f66; --faint:#6e7178;
      --accent:#b3452a; --accent-deep:#9c3a22; --accent-ink:#fff8f4; --glow:rgba(179,69,42,.16);
      --ok:#2f7d55; --bad:#b5342a; --neutral:#5c5f66; --shadow:rgba(60,45,35,.16);
    }
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  html, body { min-height:100%; }
  body { display:grid; place-items:center; min-height:100vh; padding:32px 18px; background:var(--bg); color:var(--text);
    font:15px/1.6 var(--sans); -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  main { width:100%; max-width:460px; }
  .brand { display:flex; align-items:center; justify-content:center; gap:9px; margin-bottom:18px; color:var(--dim); font-size:14px; font-weight:600; letter-spacing:.01em; }
  .mark { width:24px; height:24px; filter:drop-shadow(0 2px 8px var(--glow)); }
  .card { padding:32px 30px 26px; border:1px solid var(--border); border-radius:18px; background:var(--card); box-shadow:0 24px 60px -24px var(--shadow); text-align:center; }
  .badge { width:56px; height:56px; margin:0 auto 18px; display:grid; place-items:center; border-radius:50%;
    color:var(--tone); background:color-mix(in srgb, var(--tone) 14%, transparent); box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--tone) 30%, transparent);
    animation:pop .42s cubic-bezier(.2,.9,.3,1.25) both; }
  .badge svg { width:28px; height:28px; fill:none; stroke:currentColor; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; }
  .tone-ok { --tone:var(--ok); } .tone-bad { --tone:var(--bad); } .tone-neutral { --tone:var(--neutral); }
  h1 { font-size:22px; line-height:1.3; font-weight:650; letter-spacing:-.01em; }
  .lead { margin-top:8px; color:var(--dim); overflow-wrap:anywhere; }
  .who { color:var(--text); font-weight:600; }
  .detail { margin-top:16px; padding:11px 13px; border:1px solid var(--border); border-radius:10px; background:var(--inset); color:var(--text);
    text-align:left; font:12.5px/1.55 var(--mono); overflow-wrap:anywhere; white-space:pre-wrap; }
  .detail-label { display:block; margin-bottom:3px; font:600 11px/1.4 var(--sans); letter-spacing:.04em; text-transform:uppercase; color:var(--faint); }
  .next { margin-top:20px; padding-top:18px; border-top:1px solid var(--border); color:var(--text); font-size:14px; font-weight:500; }
  footer { margin-top:18px; text-align:center; color:var(--faint); font-size:12.5px; line-height:1.6; }
  footer p + p { margin-top:4px; }
  a { color:var(--dim); text-decoration:none; border-radius:4px; white-space:nowrap; }
  a:hover { color:var(--text); text-decoration:underline; text-underline-offset:3px; }
  a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; color:var(--text); }
  .ext { width:11px; height:11px; margin-left:3px; vertical-align:-1px; fill:none; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; }
  .dot { margin:0 7px; opacity:.6; }
  @keyframes pop { from { transform:scale(.6); opacity:0; } to { transform:scale(1); opacity:1; } }
  @media (prefers-reduced-motion: reduce) { .badge { animation:none; } }
  @media (max-width:420px) { body { padding:20px 12px; place-items:start center; } .card { padding:26px 20px 22px; border-radius:16px; } h1 { font-size:20px; } }
</style>
</head>
<body>
<main aria-labelledby="title">
  <div class="brand">${MARK}<span>CliDeck</span></div>
  <section class="card tone-${view.tone}">
    <div class="badge" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${ICONS[state]}</svg></div>
    <h1 id="title">${escapeHtml(view.heading)}</h1>
    <p class="lead">${view.lead}</p>
    ${detail}
    <p class="next">${escapeHtml(view.next)}</p>
  </section>
  <footer>
    <p>CliDeck connects to Google with gog, an open-source command-line tool.</p>
    <p><a href="${GOG_URL}" target="_blank" rel="noopener noreferrer">gog on GitHub${EXTERNAL}</a><span class="dot" aria-hidden="true">·</span><a href="${CLIDECK_URL}" target="_blank" rel="noopener noreferrer">CliDeck on GitHub${EXTERNAL}</a></p>
  </footer>
</main>
</body>
</html>
`;
}

module.exports = { renderOAuthPage };
