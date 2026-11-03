#!/usr/bin/env node
// Agent Floor: receives Claude Code hook events and streams the floor state to the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4777;
const HOST = '127.0.0.1';
const PAGE = path.join(__dirname, 'public', 'index.html');

const state = { sessions: {}, agents: {}, log: [], toolCount: 0 };
const clients = new Set();

const base = (p) => (p ? path.basename(String(p)) : '');
const clip = (s, n = 42) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Mask anything that looks like a credential before it reaches a label or the log.
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\br8_[A-Za-z0-9]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /(bearer|basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\b([A-Za-z_]*(key|token|secret|password|passwd|pwd|auth)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
];
const redact = (s) =>
  SECRET_PATTERNS.reduce((out, re) => out.replace(re, (m, name, _k, _v) =>
    re.source.includes('[=:]') ? `${name}=•••` : '•••'), String(s || ''));

// Turn a tool call into a short human label and a screen category.
function describe(tool = '', input = {}) {
  input = input || {};
  switch (tool) {
    case 'Read': return ['Reading ' + base(input.file_path), 'read'];
    case 'Grep': return [`Searching for "${clip(input.pattern, 24)}"`, 'read'];
    case 'Glob': return ['Looking for ' + clip(input.pattern, 28), 'read'];
    case 'LS': return ['Looking around ' + base(input.path), 'read'];
    case 'Edit':
    case 'MultiEdit': return ['Editing ' + base(input.file_path), 'write'];
    case 'Write': return ['Writing ' + base(input.file_path), 'write'];
    case 'NotebookEdit': return ['Editing ' + base(input.notebook_path), 'write'];
    case 'Bash': return [input.description ? clip(input.description) : '$ ' + clip(input.command, 40), 'shell'];
    case 'Monitor': return ['Watching a process', 'shell'];
    case 'WebSearch': return [`Searching the web: "${clip(input.query, 28)}"`, 'web'];
    case 'WebFetch': {
      let host = '';
      try { host = new URL(input.url).hostname.replace(/^www\./, ''); } catch {}
      return ['Reading ' + (host || 'a web page'), 'web'];
    }
    case 'Agent':
    case 'Task': return [`Briefing ${input.subagent_type || 'a helper'} agent`, 'delegate'];
    case 'Workflow': return ['Running a workflow', 'delegate'];
    case 'SendMessage': return ['Messaging a teammate', 'delegate'];
    case 'Skill': return ['Using skill ' + clip(input.skill, 24), 'think'];
    case 'TodoWrite': return ['Updating the plan', 'think'];
    case 'ToolSearch': return ['Loading tools', 'think'];
    case 'AskUserQuestion': return ['Asking you a question', 'waiting'];
    case 'Artifact': return ['Publishing a page', 'write'];
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__');
    const srv = server.replace(/^claude_ai_/, '').replace(/_/g, ' ');
    return [`${clip(name.replace(/[-_]/g, ' '), 24)} · ${srv}`, 'web'];
  }
  return [tool || 'Working', 'think'];
}

function addLog(who, text, cat = 'think', color) {
  state.log.unshift({ t: Date.now(), who, text: redact(text), cat, color });
  state.log.length = Math.min(state.log.length, 60);
}

function set(target, status, cat, label) {
  target.status = status;
  target.cat = cat;
  target.label = redact(label);
}

function handle(e) {
  const sid = e.session_id;
  const ev = e.hook_event_name;
  if (!sid || !ev) return;
  const now = Date.now();

  let s = state.sessions[sid];
  if (!s) {
    if (ev === 'SessionEnd') return;
    s = state.sessions[sid] = {
      id: sid, project: base(e.cwd) || 'session', status: 'idle', cat: 'idle',
      label: 'Ready', started: now, since: now, seen: now, tools: 0,
    };
    addLog(s.project, 'opened a session', 'idle');
  }
  s.seen = now;
  if (e.cwd) s.project = base(e.cwd);

  // Tool calls made inside a subagent carry its agent_id.
  let target = s;
  let who = s.project;
  if (e.agent_id) {
    let a = state.agents[e.agent_id];
    if (!a && ev !== 'SubagentStop') {
      a = state.agents[e.agent_id] = {
        id: e.agent_id, sessionId: sid, type: e.agent_type || 'agent', status: 'working',
        cat: 'think', label: 'Getting briefed', started: now, since: now, seen: now, tools: 0,
      };
      addLog(a.type, 'joined the floor', 'delegate');
    }
    if (a) {
      a.seen = now;
      if (e.agent_type) a.type = e.agent_type;
      target = a;
      who = a.type;
    }
  }

  switch (ev) {
    case 'SessionStart':
      set(s, 'idle', 'idle', 'Ready');
      break;
    case 'UserPromptSubmit':
      set(s, 'working', 'think', 'Thinking');
      s.since = now;
      addLog(who, 'got a new task', 'think');
      break;
    case 'PreToolUse': {
      const [label, cat] = describe(e.tool_name, e.tool_input);
      set(target, cat === 'waiting' ? 'waiting' : 'working', cat, label);
      target.tools++;
      if (target !== s) s.tools++;
      state.toolCount++;
      addLog(who, label, cat);
      break;
    }
    case 'PostToolUseFailure':
      addLog(who, `${e.tool_name || 'a tool'} failed`, 'error');
      break;
    case 'PermissionRequest':
      set(s, 'waiting', 'waiting', 'Needs your permission');
      addLog(who, 'needs your permission', 'waiting');
      break;
    case 'Notification':
      set(s, 'waiting', 'waiting', clip(e.message || 'Needs your input', 40));
      addLog(who, clip(e.message || 'needs your input', 50), 'waiting');
      break;
    case 'SubagentStart':
      if (target !== s) set(target, 'working', 'think', 'Getting briefed');
      break;
    case 'SubagentStop':
      if (target !== s) {
        set(target, 'done', 'done', 'Finished');
        target.ended = now;
        addLog(who, 'finished and left', 'done');
      }
      break;
    case 'Stop':
      set(s, 'idle', 'idle', 'Waiting for you');
      addLog(who, 'finished the task', 'done');
      break;
    case 'SessionEnd':
      delete state.sessions[sid];
      for (const id in state.agents) if (state.agents[id].sessionId === sid) delete state.agents[id];
      addLog(who, 'closed the session', 'idle');
      break;
  }
  broadcast();
}

// Clear out finished agents and stale sessions.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, a] of Object.entries(state.agents)) {
    if ((a.status === 'done' && now - a.ended > 6000) || now - a.seen > 20 * 60e3) {
      delete state.agents[id];
      changed = true;
    }
  }
  for (const [id, s] of Object.entries(state.sessions)) {
    if (s.status === 'working' && now - s.seen > 15 * 60e3) { set(s, 'idle', 'idle', 'Quiet for a while'); changed = true; }
    if (now - s.seen > 3 * 3600e3) { delete state.sessions[id]; changed = true; }
  }
  if (changed) broadcast();
}, 2000);

let pending = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const msg = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(msg);
  }, 80);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { handle(JSON.parse(body)); } catch {}
      res.writeHead(204).end();
    });
    return;
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state));
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(PAGE).pipe(res);
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, HOST, () => console.log(`Agent Floor running at http://localhost:${PORT}`));
