const { resolve } = require('node:path');
const { MIN_INTERVAL, MAX_INTERVAL } = require('./monitors');

const HELP = `Usage:
  clideck monitor add --run <command> [--name <description>] [--every 5m | --at 09:00]
                      [--mode change|items|until-success] [--wake <session>] [--once]
                      [--resume-session] [--cwd <folder>] [--json]
  clideck monitor list [--json]
  clideck monitor read <event-id> [--json]
  clideck monitor pause|resume|remove|check|acknowledge <id>

Findings arrive as one-line notices. Run the read command in the receiving session for the full output.
CliDeck keeps up to 100 recent events within its monitor storage limit. --wake selects another target.
In change/items mode, the first successful check silently saves a baseline.
Existing items are not reported. Items mode needs a top-level JSON array with a
stable id field per item (at most 4000 remembered); only new IDs are reported.
Until-success fires once on exit 0; exit 1 means not ready, other codes are errors.
Use a short completion check (e.g. test -f export.done), not the long job itself.
--at runs once at the next HH:mm in the engine timezone, or at an ISO date with offset.
Intervals: 30s to 30d. Checks run one at a time, max 30 seconds and 64 KiB output.
Busy/typing sessions wait; stopped sessions resume only with --resume-session.
Two consecutive check failures notify the creating agent once until recovery, even with --wake.
The first failed check retries after 30s; delivery/target errors notify immediately.
The notice includes the error and exact pause/remove/original-add commands; correct before recreating.
Error notices do not complete one-shot monitors or block subsequent checks.
acknowledge clears uncertain delivery WITHOUT resending it; inspect the terminal first.
Monitors run while CliDeck is running and the Mac/Linux host is awake.
Commands use /bin/sh, the saved working folder and the engine environment (no shell profile).
Use short read-only commands, full paths when needed, and no inline credentials.
Read help and list existing monitors before adding; pause/remove unneeded checks.
Every command also supports --url <engine-url>.`;

function parseMonitorArgs(args, env) {
  const [action = 'list', ...rest] = args;
  const body = { action }, options = { url: env.CLIDECK_URL || `http://127.0.0.1:${env.CLIDECK_PORT || env.PORT || 4000}`, json: false, body };
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (!['list', 'add', 'read', 'pause', 'resume', 'remove', 'check', 'acknowledge'].includes(action)) throw new Error(HELP);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') options.json = true;
    else if (action === 'add' && a === '--once') body.once = true;
    else if (action === 'add' && a === '--resume-session') body.resumeSession = true;
    else if (a === '--url') { options.url = rest[++i]; if (!options.url) throw new Error('--url requires a value.'); }
    else if (action === 'add' && ['--run', '--name', '--every', '--at', '--mode', '--wake', '--cwd'].includes(a)) {
      const value = rest[++i]; if (!value) throw new Error(`${a} requires a value.`);
      if (a === '--every') {
        const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
        const ms = match ? Number(match[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[match[2]] : 0;
        if (!Number.isSafeInteger(ms) || ms < MIN_INTERVAL || ms > MAX_INTERVAL) throw new Error('Use --every between 30s and 30d.');
        body.everyMs = ms;
      } else if (a === '--cwd') body.cwd = resolve(value);
      else body[{ '--run': 'command', '--name': 'name', '--at': 'at', '--mode': 'mode', '--wake': 'target' }[a]] = value;
    } else if (action !== 'add' && action !== 'list' && !a.startsWith('-') && !body.id) body.id = a;
    else throw new Error(`Unknown monitor argument: ${a}\n${HELP}`);
  }
  if (action === 'add') {
    if (!body.command) throw new Error('--run is required.');
    if (body.at !== undefined && body.everyMs !== undefined) throw new Error('Choose --at or --every, not both.');
    body.cwd ??= process.cwd();
  } else if (action === 'read' && !body.id) throw new Error('Event ID required. Use the ID from the monitor notice.');
  else if (action !== 'list' && !body.id) throw new Error('Monitor ID required. Use clideck monitor list.');
  if (action === 'read' || action === 'add') {
    body.callerSessionId = env.CLIDECK_SESSION_ID || env.CLIDECK_NEXT_SESSION_ID;
    if (!body.callerSessionId) throw new Error(`Run monitor ${action} inside a CliDeck session.`);
  }
  return options;
}

async function runMonitorCli(args, env, io, requestJson) {
  const options = parseMonitorArgs(args, env);
  if (options.help) return io.stdout.write(HELP + '\n');
  const result = await requestJson(options.url, '/api/monitors', options.body.action === 'list' ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body),
  });
  if (options.json) return io.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.error) throw new Error(result.error);
  if (options.body.action === 'read') {
    const output = result.output.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Bidi_Control}]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return io.stdout.write(`${result.source}\n\n${output}\n`);
  }
  const rows = result.id ? result.monitors.filter(m => m.id === result.id) : result.monitors;
  io.stdout.write((rows.length ? rows.map(m => `${m.id} | ${m.name} | ${m.state} | ${m.sessionName || m.sessionId}\n  ${m.message}${m.nextCheckAt ? '\n  Next check: ' + new Date(m.nextCheckAt).toISOString() : ''}`).join('\n') : 'No monitors.') + '\n');
}

module.exports = { runMonitorCli, parseMonitorArgs };
