function terminalLink(url, text = url) {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function openUrlHint(platform = process.platform) {
  return platform === 'darwin' ? 'Cmd+click to open' : 'Ctrl+click to open';
}

function startupBanner({ version, url, isTTY, platform }) {
  if (!isTTY) return `CliDeck v${version} listening at ${url}`;
  return `
\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;239m   ██████╗\x1b[38;5;242m██╗     \x1b[38;5;245m██╗\x1b[38;5;105m██████╗ \x1b[38;5;141m███████╗\x1b[38;5;147m ██████╗\x1b[38;5;183m██╗  ██╗\x1b[0m
\x1b[38;5;239m  ██╔════╝\x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██╔══██╗\x1b[38;5;141m██╔════╝\x1b[38;5;147m██╔════╝\x1b[38;5;183m██║ ██╔╝\x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m█████╗  \x1b[38;5;147m██║     \x1b[38;5;183m█████╔╝ \x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m██╔══╝  \x1b[38;5;147m██║     \x1b[38;5;183m██╔═██╗ \x1b[0m
\x1b[38;5;239m  ╚██████╗\x1b[38;5;242m███████╗\x1b[38;5;245m██║\x1b[38;5;105m██████╔╝\x1b[38;5;141m███████╗\x1b[38;5;147m╚██████╗\x1b[38;5;183m██║  ██╗\x1b[0m
\x1b[38;5;239m   ╚═════╝\x1b[38;5;242m╚══════╝\x1b[38;5;245m╚═╝\x1b[38;5;105m╚═════╝ \x1b[38;5;141m╚══════╝\x1b[38;5;147m ╚═════╝\x1b[38;5;183m╚═╝  ╚═╝\x1b[0m

\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;245m  v${version}\x1b[0m

\x1b[38;5;252m  ▸ Ready at \x1b[38;5;44m${terminalLink(url)}\x1b[38;5;245m (${openUrlHint(platform)})\x1b[0m
\x1b[38;5;245m  ▸ Stop with \x1b[38;5;252mCtrl+C\x1b[38;5;245m · Restart anytime with \x1b[38;5;252mclideck\x1b[0m`;
}

function alreadyRunningLine(url, isTTY) {
  return `CliDeck is already running at ${isTTY ? terminalLink(url) : url}`;
}

function nonLoopbackWarning(host) {
  return `[SECURITY WARNING] clideck-next is listening on non-loopback host ${host} without authentication.`;
}

// Do not hold up startup for the registry or turn a network failure into a launch
// failure. Source checkouts and installed packages need different update advice.
async function notifyUpdate({ currentVersion, output = process.stdout, sourceCheckout = false,
  check = require('./update-check').checkForUpdate }) {
  if (!output.isTTY) return;
  try {
    const latest = await check({ currentVersion });
    if (!latest) return;
    const instruction = sourceCheckout ? 'Update your source checkout, then restart CliDeck.'
      : 'Run npm install -g clideck, then restart CliDeck.';
    output.write(`\nCliDeck update available: ${currentVersion} → ${latest}. ${instruction}\n`);
  } catch {} // Optional notice; offline startup still works.
}

module.exports = {
  notifyUpdate,
  alreadyRunningLine,
  nonLoopbackWarning,
  openUrlHint,
  startupBanner,
  terminalLink,
};
