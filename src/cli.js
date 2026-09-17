const http = require('http');
const https = require('https');
const { open, readFile } = require('fs/promises');
const { resolve } = require('path');
const { MAX_CONTENT_BYTES } = require('./content-store');
const { readPluginManifest } = require('./plugin-manifest');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function usage(pluginCommands = []) {
  const lines = [
    'Usage:',
    '  clideck [--port <port>] [--host <loopback-host>] [--data-dir <folder>]',
    '  clideck --version',
    '  clideck agents [--all] [--json] [--url <url>]',
    '  clideck ask status [--all] [--json] [--url <url>]',
    '  clideck ask <target> <message> [--timeout 10m] [--url <url>]',
    '  clideck ask <target> <message> --steer [--url <url>]',
    '  cat message.txt | clideck ask <target> [--timeout 10m]',
    '  clideck show <path> [--kind <kind>] [--url <url>]',
    '  clideck show --template > report.html',
    '  cat output | clideck show --stdin --kind <kind> --name <name>',
    '  clideck prompt "<question>" [--options "a,b,c"] [--timeout 10m]',
    '  clideck annotate <image-file> [--timeout 10m]',
    '  clideck plugins [--json] [--url <url>]',
    '  clideck plugin install <folder> [--url <url>]',
    '  clideck plugin validate <folder> [--json]',
    '  clideck [--url <url>] <plugin-id>/<command> [arguments]',
    '',
    'Running clideck starts the local engine on port 4000; --port, CLIDECK_PORT, or PORT overrides it.',
    'Agents lists current-project sessions, including dormant (stopped) ones; --all groups every project.',
    'Use current addresses from agents, not old handoffs. last-active is recorded activity, not a shutdown time.',
    'Normal asks require an idle target and wait for its answer.',
    'If the target is working, --steer injects guidance immediately and returns without waiting.',
    'Example: clideck ask "@project/agent" "Use the new constraint" --steer',
    'Show supports text, JSON, markdown, HTML, PDF, Mermaid, diff, image, and video files.',
  ];
  if (pluginCommands.length) {
    lines.push('', 'Installed plugin commands:');
    for (const command of pluginCommands) {
      lines.push(`  clideck ${command.usage} — ${command.description}`);
    }
  }
  return lines.join('\n');
}

function parseDuration(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) return null;
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase()];
  const duration = Math.round(Number(match[1]) * scale);
  return duration > 0 && duration <= MAX_TIMEOUT_MS ? duration : null;
}

function defaultUrl(env) {
  return env.CLIDECK_URL || `http://127.0.0.1:${env.CLIDECK_PORT || env.PORT || 4000}`;
}

function parseOptions(
  args,
  env,
  {
    allowTimeout = false,
    allowContent = false,
    allowPromptOptions = false,
    allowSteer = false,
    allowAll = false,
  } = {},
) {
  const options = {
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: defaultUrl(env),
    stdin: false,
    template: false,
    kind: '',
    name: '',
    promptOptions: null,
    steer: false,
    all: false,
  };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (allowAll && argument === '--all') options.all = true;
    else if (argument === '--url') {
      options.url = args[++index];
      if (!options.url) throw new Error('--url requires a value.');
    } else if (allowTimeout && argument === '--timeout') {
      options.timeoutMs = parseDuration(args[++index]);
      if (!options.timeoutMs) throw new Error('Invalid timeout. Use values such as 30s, 10m, or 1h.');
    } else if (allowContent && argument === '--stdin') {
      options.stdin = true;
    } else if (allowContent && argument === '--template') {
      options.template = true;
    } else if (allowContent && argument === '--kind') {
      options.kind = args[++index];
      if (!options.kind) throw new Error('--kind requires a value.');
    } else if (allowContent && argument === '--name') {
      options.name = args[++index];
      if (!options.name) throw new Error('--name requires a value.');
    } else if (allowPromptOptions && argument === '--options') {
      options.promptOptions = args[++index];
      if (!options.promptOptions) throw new Error('--options requires a value.');
    } else if (allowSteer && argument === '--steer') {
      options.steer = true;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}. Hint: run clideck --help for supported options.`);
    else positional.push(argument);
  }
  return { ...options, positional };
}

function callerSessionId(env) {
  return String(env.CLIDECK_SESSION_ID || env.CLIDECK_NEXT_SESSION_ID || '').trim();
}

function requireCaller(env) {
  const id = callerSessionId(env);
  if (!id) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');
  return id;
}

function oneLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function friendlyError(body, status, pathname) {
  if (body.error === 'timeout' && (pathname === '/prompt' || pathname === '/annotate')) {
    return 'Timed out waiting for the user. Hint: the question is closed; ask again only if an answer is still needed.';
  }
  const messages = {
    busy: 'Target session is busy and cannot be steered right now.',
    not_working: 'Target session is idle. Send a normal ask without --steer.',
    dormant: 'Target session is dormant (stopped).',
    unknown_target: 'No matching target session was found.',
    ambiguous_target: 'Multiple target sessions match. Use the session id.',
    timeout: 'Timed out waiting for the target session.',
    unsupported_target: 'This session does not support ask.',
    target_closed: 'Target session stopped before answering.',
  };
  const hints = {
    dormant: 'Run clideck agents for current peers, or clideck agents --all for other projects. Ask the user to resume this session only if it is still needed.',
    unknown_target: 'Run clideck agents; use --all to search other projects. Copy the current ask address.',
    unknown_project: 'Run clideck agents --all for current project names and ask addresses.',
    ambiguous_target: 'Run clideck agents --all --json and use the exact session id.',
    ambiguous_project: 'Run clideck agents --all --json; address the target as @projectId/sessionId.',
    busy: body.message ? 'Use clideck ask status to recheck before retrying.' : 'Use clideck ask status to recheck; the peer may need to finish or dismiss a prompt.',
    not_working: 'Use clideck ask status to check current availability.',
    timeout: 'Use clideck ask status to check progress. The work may still be running; do not resend it blindly.',
    unsupported_target: 'Run clideck agents and choose an idle agent without the no-ask marker.',
    target_closed: 'Run clideck agents again and choose a current peer.',
    missing_caller: 'Run this command inside a live CliDeck session.',
    unknown_caller: 'Run this command from the current CliDeck terminal, not a saved session id.',
    unavailable: 'Refresh with clideck agents before retrying; the session may be closing.',
    invalid_target: 'Use an address from clideck agents --all: @project/session.',
  };
  const message = body.message || messages[body.error] || body.error || `CliDeck request failed (${status}).`;
  return `${message}\nHint: ${hints[body.error] || 'Run clideck --help to check the command and its options.'}`;
}

function requestJson(baseUrl, pathname, options = {}) {
  let url;
  try {
    url = new URL(pathname, baseUrl);
  } catch {
    throw new Error(`Invalid CliDeck URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid CliDeck URL: ${baseUrl}`);
  }
  const { timeoutMs = 5000, body: requestBody, ...requestOptions } = options;
  const connectionMessage = `Cannot connect to CliDeck at ${baseUrl}. Hint: check that CliDeck is running and that --url points to its engine.`;
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      requestOptions,
      (response) => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('error', () => finish(
          rejectRequest,
          new Error(connectionMessage),
        ));
        response.on('end', () => {
          let responseBody = {};
          try {
            responseBody = text ? JSON.parse(text) : {};
          } catch {}
          const status = response.statusCode || 500;
          if (status < 200 || status >= 300) {
            finish(rejectRequest, new Error(friendlyError(responseBody, status, pathname)));
          } else finish(resolveRequest, responseBody);
        });
      },
    );
    request.on('error', (error) => finish(
      rejectRequest,
      error.code === 'CLIDECK_TIMEOUT'
        ? error
        : new Error(connectionMessage),
    ));
    timer = setTimeout(() => {
      const error = new Error('CliDeck request timed out. Hint: check the engine connection before retrying; an earlier request may still be running.');
      error.code = 'CLIDECK_TIMEOUT';
      request.destroy(error);
    }, timeoutMs);
    timer.unref?.();
    request.end(requestBody);
  });
}

async function getAgents(url, callerId, all = false) {
  return (await requestJson(
    url,
    `/api/session/agents?callerSessionId=${encodeURIComponent(callerId)}${all ? '&all=true' : ''}`,
  )).agents || [];
}

async function getPlugins(url) {
  return (await requestJson(url, '/api/plugins')).plugins || [];
}

function agentStatus(agent) {
  return agent.status || (agent.live === false ? 'dormant' : agent.working ? 'working' : 'idle');
}

function formatAgents(agents, { all = false } = {}) {
  const addressCounts = new Map();
  for (const agent of agents) addressCounts.set(agent.address, (addressCounts.get(agent.address) || 0) + 1);
  const row = (agent) => `${oneLine(agent.name || agent.id)} | ${agentStatus(agent)}`
    + `${agent.caller ? ' self' : ''} | ${oneLine(agent.provider)}`
    + ` | ask=${JSON.stringify(agent.address)}${addressCounts.get(agent.address) > 1 ? ` id=${agent.id}` : ''}`
    + `${agent.supportsAsk === false ? ' no-ask' : ''}`
    + `${agent.lastActive ? ` | last-active=${agent.lastActive}` : ''}`;
  let lines;
  if (all) {
    const groups = new Map();
    for (const agent of agents) {
      const key = agent.projectId || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(agent);
    }
    lines = [...groups.values()].map((group) => `${oneLine(group[0].projectName || group[0].projectId || 'No project')}${group.some((agent) => agent.caller) ? ' (current)' : ''}\n${group.map((agent) => `  ${row(agent)}`).join('\n')}`);
  } else lines = agents.map(row);
  if (!lines.length) lines.push('No sessions found.');
  lines.push(`Hint: ${all ? 'Use the printed ask address across projects.' : 'Use --all for other projects.'} Ask idle agents; --steer sends guidance to working agents without waiting.`);
  if (agents.some((agent) => agentStatus(agent) === 'dormant')) {
    lines.push('Hint: dormant = stopped, not a required role. Prefer live peers. last-active is recorded activity, not stop time.');
  }
  if (!agents.some((agent) => !agent.caller && agentStatus(agent) !== 'dormant' && agent.supportsAsk !== false)) {
    lines.push('Hint: no live ask-capable peers in this list. Continue alone, or ask the user to open a peer only if the task benefits.');
  }
  return lines.join('\n');
}

function formatStatus(agents, options) { return formatAgents(agents, options); }

async function readStdin(stream) {
  if (stream.isTTY) return '';
  let value = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) value += chunk;
  return value.trim();
}

async function readContentStdin(stream) {
  if (stream.isTTY) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_CONTENT_BYTES) {
      throw new Error('Content payload exceeds the 2MB limit.');
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readPluginStdin(stream) {
  if (stream.isTTY) return '';
  let value = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    value += chunk;
    if (Buffer.byteLength(value) > 1024 * 1024) {
      throw new Error('Plugin command stdin exceeds the 1MB limit.');
    }
  }
  return value;
}

function startProgress(options, callerId, io) {
  const started = Date.now();
  let stopped = false;
  io.stderr.write(`[clideck ask] contacting "${options.target}". waiting up to `
    + `${Math.round(options.timeoutMs / 1000)}s.\n`);
  const tick = async () => {
    if (stopped) return;
    try {
      const agents = await getAgents(options.url, callerId, options.target.startsWith('@'));
      const target = agents.find((agent) => agent.id === options.target
        || agent.name === options.target || agent.address === options.target);
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (!target) {
        io.stderr.write(`[clideck ask] still waiting (${elapsed}s elapsed).\n`);
        return;
      }
      const preview = oneLine(target.lastPreview);
      io.stderr.write(`[clideck ask] ${target.name || target.id} is `
        + `${agentStatus(target)} (${elapsed}s elapsed)`
        + `${preview ? ` — ${preview}` : ''}.\n`);
    } catch {}
  };
  const interval = setInterval(tick, 15_000);
  interval.unref?.();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

async function runAgents(args, env, io) {
  const options = parseOptions(args, env, { allowAll: true });
  if (options.help) return io.stdout.write(`${usage()}\n`);
  if (options.positional.length) throw new Error('Unexpected agents argument. Hint: use clideck agents [--all] [--json].');
  const agents = await getAgents(options.url, requireCaller(env), options.all);
  io.stdout.write(options.json
    ? `${JSON.stringify(agents, null, 2)}\n` : `${formatAgents(agents, options)}\n`);
}

function formatPlugins(plugins) {
  if (!plugins.length) return 'No plugins installed. Hint: use clideck plugin install <folder> to install one.';
  return plugins.map((plugin) => {
    const commands = (plugin.commands || []).map((command) => (
      command.usage
    )).join(', ');
    return `${plugin.enabled ? plugin.status : 'disabled'}  ${plugin.name} ${plugin.version}`
      + `${commands ? ` — ${commands}` : ''}`;
  }).join('\n');
}

async function runPlugins(args, env, io) {
  const options = parseOptions(args, env);
  if (options.positional.length) throw new Error(usage());
  const plugins = await getPlugins(options.url);
  io.stdout.write(options.json
    ? `${JSON.stringify(plugins, null, 2)}\n`
    : `${formatPlugins(plugins)}\n`);
}

async function runPluginAdmin(args, env, io) {
  const options = parseOptions(args, env);
  const [operation, path, ...extra] = options.positional;
  if (!path || extra.length || (operation !== 'install' && operation !== 'validate')) {
    throw new Error(usage());
  }
  if (operation === 'validate') {
    const manifest = readPluginManifest(resolve(process.cwd(), path));
    const summary = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      commands: manifest.commands,
      settings: manifest.settings,
      viewers: manifest.viewers,
      server: manifest.hasServer,
      client: manifest.hasClient,
      public: manifest.hasPublic,
    };
    io.stdout.write(options.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `Valid plugin: ${manifest.id} ${manifest.version}\n`);
    return;
  }
  const result = await requestJson(options.url, '/api/plugins/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: resolve(process.cwd(), path) }),
    timeoutMs: 30_000,
  });
  io.stdout.write(`Installed ${result.pluginId}.\n`);
}

async function runPluginCommand(address, args, env, io) {
  const match = String(address).match(/^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/);
  if (!match) throw new Error(usage());
  const result = await requestJson(
    defaultUrl(env),
    `/api/plugins/command/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: requireCaller(env),
        args,
        stdin: await readPluginStdin(io.stdin),
      }),
      timeoutMs: 60 * 60 * 1000,
    },
  );
  if (result.stdout) io.stdout.write(String(result.stdout));
  if (result.stderr) io.stderr.write(String(result.stderr));
  if (result.exitCode) io.exitCode = result.exitCode;
}

async function runStatus(args, env, io) {
  const options = parseOptions(args, env, { allowAll: true });
  if (options.help) return io.stdout.write(`${usage()}\n`);
  if (options.positional.length) throw new Error('Unexpected status argument. Hint: use clideck ask status [--all] [--json].');
  const agents = await getAgents(options.url, requireCaller(env), options.all);
  io.stdout.write(options.json
    ? `${JSON.stringify(agents.map((agent) => ({
      ...agent,
      status: agentStatus(agent),
    })), null, 2)}\n`
    : `${formatStatus(agents, options)}\n`);
}

async function runAsk(args, env, io) {
  if (args[0] === 'status') return runStatus(args.slice(1), env, io);
  const options = parseOptions(args, env, { allowTimeout: true, allowSteer: true });
  if (options.help) return io.stdout.write(`${usage()}\n`);
  const [target, ...messageParts] = options.positional;
  const message = messageParts.join(' ').trim() || await readStdin(io.stdin);
  if (!target || !message) throw new Error(usage());
  const callerId = requireCaller(env);
  const stopProgress = options.steer ? (() => {}) : startProgress({ ...options, target }, callerId, io);
  try {
    const body = await requestJson(options.url, '/api/session/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callerSessionId: callerId,
        target,
        text: message,
        timeoutMs: options.timeoutMs,
        ...(options.steer && { steer: true }),
      }),
      timeoutMs: options.steer ? 5000 : options.timeoutMs + 5000,
    });
    if (body.steered) io.stderr.write(`[clideck ask] steered "${target}".\n`);
    else io.stdout.write(`${String(body.answer || '').trimEnd()}\n`);
  } finally {
    stopProgress();
  }
}

async function runShow(args, env, io) {
  const options = parseOptions(args, env, { allowContent: true });
  if (options.help) return io.stdout.write([
    'clideck show <path> [--kind <kind>]',
    'cat output | clideck show --stdin --kind <kind> --name <name>',
    'clideck show --template > report.html',
    '',
    'The HTML starter follows the viewing browser\'s CliDeck theme, including live changes.',
    'Edit its body and keep data-clideck-theme="auto" on <html> and the embedded CSS.',
    'Custom styles can use --cd-bg, --cd-text, --cd-surface, --cd-muted, --cd-border and --cd-accent.',
    'Outside CliDeck, the starter follows the system theme. Existing HTML keeps its own styling.',
    '',
  ].join('\n'));
  if (options.template) {
    if (options.stdin || options.kind || options.name || options.positional.length) {
      throw new Error('--template writes an HTML starter to stdout; use it without a path, --stdin, --kind or --name.');
    }
    const css = await readFile(resolve(__dirname, '../public/css/preview.css'), 'utf8');
    return io.stdout.write(`<!doctype html>
<html lang="en" data-clideck-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report</title>
<style>
${css.trim()}
</style>
</head>
<body>
<main>
  <h1>Report</h1>
  <p>Replace this with your content.</p>
</main>
</body>
</html>
`);
  }
  let content;
  if (options.stdin) {
    if (options.positional.length || !options.kind || !options.name) {
      throw new Error('--stdin requires --kind and --name, with no file path.');
    }
    content = {
      payload: await readContentStdin(io.stdin),
      kind: options.kind,
      name: options.name,
    };
  } else {
    if (options.positional.length !== 1 || options.name) throw new Error(usage());
    content = {
      path: resolve(process.cwd(), options.positional[0]),
      ...(options.kind && { kind: options.kind }),
    };
  }
  const shown = await requestJson(options.url, '/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: requireCaller(env),
      ...content,
    }),
  });
  if (shown.kind === 'html') {
    // Discovery only: a bounded header read must never turn a successful preview into a failure.
    let header = content.payload;
    if (header === undefined) {
      let file;
      try {
        file = await open(content.path, 'r');
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        header = buffer.toString('utf8', 0, bytesRead);
      } catch { /* the file may have moved since the preview opened */ }
      finally { if (file) await file.close().catch(() => {}); }
    }
    if (typeof header === 'string' && !/<html\b[^>]*\sdata-clideck-theme\s*=/i.test(header)) {
      io.stderr.write('To follow CliDeck\'s theme, start with: clideck show --template > report.html\n');
    }
  }
}

async function runPrompt(args, env, io) {
  const options = parseOptions(args, env, {
    allowTimeout: true,
    allowPromptOptions: true,
  });
  if (options.help) return io.stdout.write(`${usage()}\n`);
  const question = options.positional.join(' ').trim();
  if (!question) throw new Error(usage());
  const body = await requestJson(options.url, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: requireCaller(env),
      question,
      ...(options.promptOptions !== null && {
        options: options.promptOptions.split(',').map((value) => value.trim()),
      }),
      timeoutMs: options.timeoutMs,
    }),
    timeoutMs: options.timeoutMs + 5000,
  });
  io.stdout.write(String(body.value ?? ''));
}

async function runAnnotate(args, env, io) {
  const options = parseOptions(args, env, { allowTimeout: true });
  if (options.help) return io.stdout.write(`${usage()}\n`);
  if (options.positional.length !== 1) throw new Error(usage());
  const body = await requestJson(options.url, '/annotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: requireCaller(env),
      path: resolve(process.cwd(), options.positional[0]),
      timeoutMs: options.timeoutMs,
    }),
    timeoutMs: options.timeoutMs + 5000,
  });
  io.stdout.write(String(body.value ?? ''));
}

async function run(args, env = process.env, io = process) {
  if (args.length === 0 || ['--port', '--host', '--data-dir', '--cwd', '--command'].includes(args[0].split('=')[0])) {
    return require('./server').main(args, env);
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    return io.stdout.write(`${require('../package.json').version}\n`);
  }
  let commandArgs = args;
  let commandEnv = env;
  if (commandArgs[0] === '--url') {
    const url = commandArgs[1];
    if (!url) throw new Error('--url requires a value.');
    commandEnv = { ...env, CLIDECK_URL: url };
    commandArgs = commandArgs.slice(2);
  }
  const [command, ...rest] = commandArgs;
  if (command === 'agents') return runAgents(rest, commandEnv, io);
  if (command === 'ask') return runAsk(rest, commandEnv, io);
  if (command === 'show') return runShow(rest, commandEnv, io);
  if (command === 'prompt') return runPrompt(rest, commandEnv, io);
  if (command === 'annotate') return runAnnotate(rest, commandEnv, io);
  if (command === 'plugins') return runPlugins(rest, commandEnv, io);
  if (command === 'plugin') return runPluginAdmin(rest, commandEnv, io);
  if (/^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/.test(command || '')) {
    return runPluginCommand(command, rest, commandEnv, io);
  }
  if (command === '--help' || command === '-h') {
    let commands = [];
    try {
      const options = parseOptions(rest, commandEnv);
      const plugins = await getPlugins(options.url);
      commands = plugins
        .filter((plugin) => plugin.enabled && plugin.status === 'ready')
        .flatMap((plugin) => (plugin.commands || []).map((entry) => ({
          pluginId: plugin.id, ...entry,
        })));
    } catch {}
    return io.stdout.write(`${usage(commands)}\n`);
  }
  throw new Error(usage());
}

module.exports = {
  formatAgents,
  formatPlugins,
  formatStatus,
  parseDuration,
  parseOptions,
  run,
};
