#!/usr/bin/env node
// Adds (or with --uninstall removes) the Agent Floor hooks in ~/.claude/settings.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = 'agent-floor';
const PORT = Number(process.env.PORT) || 4777;
const COMMAND = `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${PORT}/event >/dev/null 2>&1 || true # ${MARK}`;

const TOOL_EVENTS = ['PreToolUse', 'PostToolUseFailure'];
const OTHER_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification',
  'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
];

const uninstall = process.argv.includes('--uninstall');
const settings = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
if (fs.existsSync(FILE)) fs.copyFileSync(FILE, `${FILE}.bak-${Date.now()}`);

const hooks = settings.hooks || {};
const isOurs = (group) => (group.hooks || []).some((h) => String(h.command || '').includes(MARK));

for (const ev of [...TOOL_EVENTS, ...OTHER_EVENTS]) {
  const groups = (hooks[ev] || []).filter((g) => !isOurs(g));
  if (!uninstall) {
    const group = { hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 5 }] };
    if (TOOL_EVENTS.includes(ev)) group.matcher = '*';
    groups.push(group);
  }
  if (groups.length) hooks[ev] = groups;
  else delete hooks[ev];
}

if (Object.keys(hooks).length) settings.hooks = hooks;
else delete settings.hooks;

fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall ? 'Agent Floor hooks removed.' : `Agent Floor hooks installed in ${FILE}`);
