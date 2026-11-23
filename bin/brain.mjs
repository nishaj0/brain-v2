#!/usr/bin/env node
// brain: local progress tracker for Claude Code projects.
// Capture: one small Haiku call per session (trimmed digest + current project card).
// Reports: one call per day (Haiku) and per week (Sonnet), over cards and events only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOME = process.env.BRAIN_HOME || path.join(os.homedir(), '.brain');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SELF = fileURLToPath(import.meta.url);
const MODELS = {
  capture: process.env.BRAIN_CAPTURE_MODEL || 'haiku',
  daily: process.env.BRAIN_DAILY_MODEL || 'haiku',
  week: process.env.BRAIN_WEEK_MODEL || 'sonnet',
};
// Character budgets for the capture digest (~4 chars per token, ~3k tokens total).
const BUDGET = { prompts: 3500, replies: 5500, files: 800, failed: 1200, git: 1000 };
const IDLE_MIN = 20; // scan skips transcripts touched in the last 20 min (session probably still open)

const f = (...p) => path.join(HOME, ...p);
const today = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

// ---------- storage ----------
export function ensureHome() {
  for (const d of ['cards', 'reports', 'locks']) fs.mkdirSync(f(d), { recursive: true });
  if (!fs.existsSync(f('projects.json'))) {
    writeJSON(f('projects.json'), {
      aliases: {},
      ignore: ['scratch-workspaces', `${path.sep}Temp${path.sep}`, `${path.sep}.brain`],
    });
  }
  if (!fs.existsSync(f('goals.md'))) {
    fs.writeFileSync(f('goals.md'),
      '# Goals\n<!-- Optional. Write priorities, deadlines and what "done" means per project.\n' +
      '     Every daily and weekly report reads this file, so keep it short. -->\n');
  }
}
export const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
export function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const appendEvent = (e) => fs.appendFileSync(f('events.jsonl'), JSON.stringify(e) + '\n');
const log = (msg) => { try { fs.appendFileSync(f('brain.log'), `${new Date().toISOString()} ${msg}\n`); } catch {} };
export function readEvents(sinceMs = 0) {
  if (!fs.existsSync(f('events.jsonl'))) return [];
  return fs.readFileSync(f('events.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && Date.parse(e.ts) >= sinceMs);
}
const cardPath = (name) => f('cards', `${name}.json`);
export const readCard = (name) => readJSON(cardPath(name), null);

// ---------- project resolution ----------
export function resolveProject(cwd, cfg = readJSON(f('projects.json'), { aliases: {}, ignore: [] })) {
  if (!cwd) return null;
  const low = cwd.toLowerCase();
  if ((cfg.ignore || []).some((s) => low.includes(String(s).toLowerCase()))) return null;
  let root = cwd;
  // --git-common-dir points at the main repo's .git even inside a worktree, so worktrees roll up to their repo.
  const g = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  const common = g.status === 0 ? g.stdout.trim() : '';
  if (common && path.basename(common) === '.git') root = path.dirname(path.resolve(common));
  else {
    const t = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
    if (t.status === 0 && t.stdout.trim()) root = path.resolve(t.stdout.trim());
  }
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!base) return null;
  return { name: (cfg.aliases || {})[base] || base, root };
}

// ---------- transcript digest ----------
const clean = (s) => String(s)
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<\/?pasted_content[^>]*>/g, '')
  .replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g, '')
  .replace(/<(task-notification|local-command-[a-z]+)>[\s\S]*?<\/\1>/g, '')
  // Secrets pasted into chats must not reach the model or ~/.brain.
  .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
  .replace(/((?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
  .replace(/(app ?password[^\n]{0,40}?)\b[a-z]{4} ?[a-z]{4} ?[a-z]{4} ?[a-z]{4}\b/gi, '$1[REDACTED]')
  .replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';

// Keep the first item and as many of the latest items as fit in maxChars.
export function fit(items, maxChars) {
  if (!items.length) return [];
  const out = []; let used = items[0].length;
  for (let i = items.length - 1; i > 0; i--) {
    if (used + items[i].length > maxChars) { out.unshift(`(… ${i} earlier items skipped)`); break; }
    out.unshift(items[i]); used += items[i].length;
  }
  return [items[0], ...out];
}

export function digestRecords(records) {
  const prompts = [], replies = [], files = new Set(), failed = [], cmds = new Map();
  let lastReply = '', firstTs = null, lastTs = null, prevTs = null, activeMs = 0, cwd = null;
  for (const r of records) {
    if (r.isSidechain) continue;
    const ts = Date.parse(r.timestamp);
    if (!Number.isNaN(ts) && (r.type === 'user' || r.type === 'assistant')) {
      firstTs ??= ts; lastTs = ts;
      if (prevTs !== null) activeMs += Math.min(ts - prevTs, 5 * 60e3); // gaps over 5 min count as idle
      prevTs = ts;
    }
    if (r.cwd) cwd = r.cwd;
    const content = r.message?.content;
    if (r.type === 'user') {
      const blocks = Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_result' && b.is_error && cmds.has(b.tool_use_id)) {
          failed.push(`${cmds.get(b.tool_use_id)} → ${cut(clean(textOf(b.content) || String(b.content ?? '')), 150)}`);
        }
      }
      if (r.isMeta || blocks.some((b) => b?.type === 'tool_result')) continue;
      const t = clean(textOf(content));
      if (t) {
        if (lastReply) { replies.push(lastReply); lastReply = ''; }
        prompts.push(cut(t, 300));
      }
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && clean(b.text)) lastReply = cut(clean(b.text), 600);
        if (b?.type === 'tool_use') {
          const inp = b.input || {};
          if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && (inp.file_path || inp.notebook_path)) {
            const fp = inp.file_path || inp.notebook_path;
            files.add(cwd && fp.toLowerCase().startsWith(cwd.toLowerCase()) ? path.relative(cwd, fp) : fp);
          }
          if (/^(Bash|PowerShell)$/.test(b.name) && inp.command) cmds.set(b.id, cut(clean(inp.command), 120));
        }
      }
    }
  }
  if (lastReply) replies.push(lastReply);
  return {
    cwd, prompts, replies, files: [...files], failed, firstTs, lastTs,
    minutes: Math.round(activeMs / 60e3),
  };
}

function gitSummary(root, sinceMs) {
  if (!root || !sinceMs) return '';
  const run = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  const lg = run(['log', `--since=${new Date(sinceMs - 60e3).toISOString()}`, '--oneline', '-n', '15']);
  if (lg.status !== 0) return '';
  const st = run(['status', '--short']);
  const dirty = st.status === 0 ? st.stdout.split('\n').filter(Boolean).length : 0;
  return cut(`${lg.stdout.trim() || '(no commits)'}\nuncommitted files: ${dirty}`, BUDGET.git);
}

export function renderDigest(project, d, git) {
  const list = (items) => items.map((s) => `- ${s}`).join('\n') || '- (none)';
  const files = d.files.length > 25 ? [...d.files.slice(0, 25), `(+${d.files.length - 25} more)`] : d.files;
  return [
    `PROJECT: ${project}`,
    `ACTIVE MINUTES: ${d.minutes}`,
    `USER PROMPTS:\n${list(fit(d.prompts, BUDGET.prompts))}`,
    `CLAUDE REPLIES (end of each turn):\n${list(fit(d.replies, BUDGET.replies))}`,
    `FILES EDITED: ${cut(files.join(', ') || '(none)', BUDGET.files)}`,
    `FAILED COMMANDS:\n${list(fit(d.failed, BUDGET.failed))}`,
    git ? `GIT (since session start):\n${git}` : '',
  ].filter(Boolean).join('\n\n');
}

// ---------- model calls ----------
// JSON is asked for in the prompt, not via --json-schema: the schema tool costs an extra turn (measured 2x tokens).
export function callClaude({ model, system, prompt, json }) {
  const args = ['-p', '--model', model, '--safe-mode', '--tools', '', '--no-session-persistence',
    '--system-prompt', json ? `${system}\nReply with ONLY the JSON object, no prose, no code fence.` : system,
    '--output-format', 'json'];
  const r = spawnSync('claude', args, {
    input: prompt, encoding: 'utf8', cwd: HOME, timeout: 240e3, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, BRAIN_CHILD: '1' },
  });
  if (r.error) throw new Error(`claude not runnable: ${r.error.message}`);
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(`claude exit ${r.status}: ${cut((r.stderr || r.stdout || '').trim(), 400)}`); }
  if (out.is_error) throw new Error(`claude error: ${cut(String(out.result ?? out.subtype), 400)}`);
  const u = out.usage || {};
  log(`call model=${model} turns=${out.num_turns ?? '?'} in=${(u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)} out=${u.output_tokens || 0} usd=${out.total_cost_usd ?? '?'}`);
  if (!json) return String(out.result ?? '').trim();
  const m = String(out.result ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model output');
  return JSON.parse(m[0]);
}

// Model output is untrusted shape-wise: coerce to the card schema and enforce list limits here.
const MOODS = ['momentum', 'stuck', 'exploring', 'wrapping-up'];
export function normalizeUpdate(u) {
  const list = (v, max) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => cut(x.trim(), 240)).slice(0, max);
  return {
    did: cut(typeof u?.did === 'string' ? u.did.trim() : '', 400),
    next: list(u?.next, 5), waiting_on_you: list(u?.waiting_on_you, 5), claude_can_do: list(u?.claude_can_do, 5),
    broken: list(u?.broken, 5), decisions: list(u?.decisions, 3),
    mood: MOODS.includes(u?.mood) ? u.mood : 'exploring',
  };
}
const CAPTURE_SYSTEM = `You keep a one-person developer's project tracker up to date.
You get the project's CURRENT CARD and a trimmed DIGEST of one coding session with Claude.
Return the UPDATED card as a JSON object with keys did, next, waiting_on_you, claude_can_do, broken, decisions, mood:
- did: 1-2 plain sentences, what actually got done this session (not what was discussed).
- next: up to 5 concrete next steps for the project. Drop steps that are done, keep still-valid old ones.
- waiting_on_you: things only the human can do (decide, approve, pay, test by hand, create accounts, send ids).
- claude_can_do: work Claude could do next without the human.
- broken: known bugs, failing tests/builds, or unverified work, still open.
- decisions: up to 3 NEW decisions made this session, each one short line. Empty if none.
- mood: momentum | stuck | exploring | wrapping-up.
Short lines, no filler. Do not invent work that is not in the digest.`;

// ---------- capture ----------
// One global lock: captures are read-modify-write on cards and captured.json. Waits up to 5 min, then gives up
// (the next scan picks the session up). Locks older than 10 min are from a killed process.
function withLock(fn) {
  const lock = f('locks', 'capture.lock');
  const until = Date.now() + 5 * 60e3;
  for (;;) {
    try {
      if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 10 * 60e3) fs.rmSync(lock, { force: true });
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      if (Date.now() > until) { log('capture lock busy, skipped'); return { skipped: 'locked' }; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

export function capture(transcript, sessionId = path.basename(transcript, '.jsonl')) {
  ensureHome();
  return withLock(() => {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
    const captured = readJSON(f('captured.json'), {});
    const from = captured[sessionId]?.line || 0;
    if (from >= lines.length) return { skipped: 'nothing new' };
    const records = lines.slice(from).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const d = digestRecords(records);
    const mark = (why) => {
      const c = readJSON(f('captured.json'), {});
      c[sessionId] = { line: lines.length, at: new Date().toISOString(), why };
      writeJSON(f('captured.json'), c);
    };
    const proj = resolveProject(d.cwd);
    if (!proj) { mark('ignored'); return { skipped: 'ignored folder' }; }
    const base = {
      type: 'session', ts: new Date(d.lastTs || Date.now()).toISOString(), session: sessionId,
      project: proj.name, minutes: d.minutes, files: d.files.length, part: from > 0,
    };
    if (!d.prompts.length || (d.minutes < 2 && !d.files.length)) {
      if (d.prompts.length) appendEvent({ ...base, did: `(short) ${d.prompts[0]}` });
      mark('trivial');
      return { skipped: 'trivial session' };
    }
    const card = readCard(proj.name) || { project: proj.name, next: [], waiting_on_you: [], claude_can_do: [], broken: [], decisions: [] };
    const current = { next: card.next, waiting_on_you: card.waiting_on_you, claude_can_do: card.claude_can_do, broken: card.broken };
    const prompt = `CURRENT CARD:\n${JSON.stringify(current)}\n\nDIGEST:\n${renderDigest(proj.name, d, gitSummary(proj.root, d.firstTs))}`;
    const u = normalizeUpdate(callClaude({ model: MODELS.capture, system: CAPTURE_SYSTEM, prompt, json: true }));
    // An older session (caught up late) adds its event and decisions but must not overwrite newer card state.
    const older = card.last_touched && base.ts < card.last_touched;
    const state = older ? card : u;
    writeJSON(cardPath(proj.name), {
      project: proj.name, root: proj.root, updated: new Date().toISOString(),
      last_touched: older ? card.last_touched : base.ts,
      last_did: older ? card.last_did : u.did, mood: state.mood,
      next: state.next, waiting_on_you: state.waiting_on_you, claude_can_do: state.claude_can_do, broken: state.broken,
      decisions: [...(card.decisions || []), ...u.decisions.map((x) => `${today(new Date(base.ts))} ${x}`)].slice(-8),
    });
    appendEvent({ ...base, did: u.did, mood: u.mood });
    mark('captured');
    log(`captured ${proj.name} ${sessionId} ${d.minutes}m`);
    return { project: proj.name, did: u.did };
  });
}

// Hook entry: must return fast, so hand the work to a detached child.
function hook() {
  if (process.env.BRAIN_CHILD) return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { log(`hook: bad input: ${e.message}`); return; }
  if (input.agent_id || !input.transcript_path) return;
  ensureHome();
  const out = fs.openSync(f('brain.log'), 'a'); // child errors land in brain.log
  const child = spawn(process.execPath, [SELF, 'capture', input.transcript_path, input.session_id || ''], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, BRAIN_CHILD: '1' },
  });
  child.unref();
}

// Catch-up for sessions whose SessionEnd never fired (crash, closed window, plugin installed later).
export function scan(days = 2) {
  ensureHome();
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const captured = readJSON(f('captured.json'), {});
  const now = Date.now(), todo = [], results = [];
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const full = path.join(CLAUDE_PROJECTS, dir);
    let entries; try { entries = fs.readdirSync(full); } catch { continue; }
    for (const name of entries.filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(full, name);
      const mtime = fs.statSync(file).mtimeMs;
      if (now - mtime > days * 864e5 || now - mtime < IDLE_MIN * 60e3) continue;
      const id = name.slice(0, -6);
      if (captured[id] && captured[id].at && Date.parse(captured[id].at) >= mtime) continue;
      todo.push({ file, id, mtime });
    }
  }
  // Oldest first, so each card's "next steps" evolve in the order the work happened.
  for (const { file, id } of todo.sort((a, b) => a.mtime - b.mtime)) {
    try { results.push({ id, ...capture(file, id) }); } catch (e) { log(`scan fail ${id}: ${e.message}`); results.push({ id, error: e.message }); }
  }
  return results;
}

// ---------- reports ----------
function cardsText() {
  const cards = fs.readdirSync(f('cards')).filter((n) => n.endsWith('.json')).map((n) => readJSON(f('cards', n), null)).filter(Boolean);
  return cards.map((c) => {
    const days = Math.floor((Date.now() - Date.parse(c.last_touched)) / 864e5);
    const l = (k) => (c[k]?.length ? `  ${k}: ${c[k].join(' | ')}` : '');
    return [`## ${c.project} (last touched ${days}d ago, mood ${c.mood || '?'})`, `  last: ${c.last_did || ''}`,
      l('next'), l('waiting_on_you'), l('claude_can_do'), l('broken'), l('decisions')].filter(Boolean).join('\n');
  }).join('\n');
}
const goalsText = () => cut(fs.existsSync(f('goals.md')) ? fs.readFileSync(f('goals.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() : '', 2000);
function eventsText(sinceMs) {
  return readEvents(sinceMs).map((e) => e.type === 'note'
    ? `- NOTE [${e.project || 'general'}] ${e.text}`
    : `- ${e.ts.slice(0, 16)} ${e.project} ${e.minutes}m: ${e.did}`).join('\n') || '- (no activity)';
}

const DAILY_SYSTEM = `You write a one-person developer's daily priority report from their project cards.
Output markdown only, under 250 words, exactly these sections:
# Today, <date>
**Focus:** the one project and task to do first, with a short why.
**Waiting on you:** human-only items, most blocking first, with project names.
**Claude can do:** tasks to hand to Claude today.
**Skip today:** projects to leave alone and why (one line each).
**Stale:** projects untouched 7+ days, only if any.
**Yesterday:** one line per project worked on, with minutes.
Use the goals file to rank. Be direct. No filler, no invented facts.`;

export function daily() {
  ensureHome();
  scan(2);
  const prompt = `DATE: ${today()}\n\nGOALS:\n${goalsText() || '(none)'}\n\nPROJECT CARDS:\n${cardsText() || '(no cards yet)'}\n\nLAST 24H:\n${eventsText(Date.now() - 864e5)}`;
  const md = callClaude({ model: MODELS.daily, system: DAILY_SYSTEM, prompt });
  const out = f('reports', `daily-${today()}.md`);
  fs.writeFileSync(out, md + '\n');
  return { file: out, md };
}

const WEEK_SYSTEM = `You write a one-person developer's weekly review from their project cards, daily reports and goals.
Output markdown only, under 450 words, with these sections:
# Week to <date>
## Where the time went (table: project | minutes | sessions)
## Ranked priorities (each with one-line reason)
## NOW pick (one project) and backup
## Next week tasks (per project, max 3 each)
## Keep / park / kill (only projects that need a call)
## Flags (stale projects, things waiting on the human too long, repeated breakage)
Be direct. No invented facts.`;

export function week() {
  ensureHome();
  scan(7);
  const since = Date.now() - 7 * 864e5;
  const totals = {};
  for (const e of readEvents(since)) if (e.type === 'session') {
    const t = (totals[e.project] ??= { minutes: 0, sessions: 0 }); t.minutes += e.minutes || 0; t.sessions++;
  }
  const dailies = fs.readdirSync(f('reports')).filter((n) => n.startsWith('daily-')).sort().slice(-7)
    .map((n) => cut(fs.readFileSync(f('reports', n), 'utf8'), 2500)).join('\n\n---\n\n');
  const notes = readEvents(since).filter((e) => e.type === 'note').map((e) => `- [${e.project || 'general'}] ${e.text}`).join('\n');
  const prompt = `DATE: ${today()}\n\nGOALS:\n${goalsText() || '(none)'}\n\nTIME (7d): ${JSON.stringify(totals)}\n\nPROJECT CARDS:\n${cardsText()}\n\nNOTES:\n${notes || '(none)'}\n\nDAILY REPORTS:\n${dailies || '(none)'}`;
  const md = callClaude({ model: MODELS.week, system: WEEK_SYSTEM, prompt });
  const out = f('reports', `week-${today()}.md`);
  fs.writeFileSync(out, md + '\n');
  return { file: out, md };
}

function status(project) {
  ensureHome();
  if (project) {
    if (!readCard(project)) return `No card for "${project}".`;
    return cardsText().split('\n## ').map((b) => b.replace(/^## /, '')).find((b) => b.startsWith(`${project} `));
  }
  const file = f('reports', `daily-${today()}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `No report for ${today()} yet. Run: brain daily`;
}

function note(args) {
  ensureHome();
  let project = null;
  const i = args.indexOf('--project');
  if (i >= 0) { project = args[i + 1]; args.splice(i, 2); }
  else project = resolveProject(process.cwd())?.name || null;
  const text = args.join(' ').trim();
  if (!text) throw new Error('usage: brain note [--project name] <text>');
  appendEvent({ type: 'note', ts: new Date().toISOString(), project, text });
  return `noted${project ? ` for ${project}` : ''}`;
}

const USAGE = `brain <command>
  status [project]   today's report, or one project's card
  daily              build today's report (one Haiku call)
  week               build the weekly review (one Sonnet call)
  note [--project p] <text>   add a note, no model call
  list               all project cards
  scan [days]        capture sessions the hook missed
  capture <transcript.jsonl> [sessionId]
  hook               (used by the SessionEnd/PreCompact hook)
Data: ${HOME}`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'hook': return hook();
    case 'capture': return console.log(JSON.stringify(capture(rest[0], rest[1] || undefined)));
    case 'scan': return console.log(JSON.stringify(scan(Number(rest[0]) || 2), null, 1));
    case 'daily': return console.log(daily().md);
    case 'week': return console.log(week().md);
    case 'status': return console.log(status(rest[0]));
    case 'note': return console.log(note(rest));
    case 'list': ensureHome(); return console.log(cardsText() || 'No projects captured yet.');
    default: return console.log(USAGE);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => {
    log(`error ${process.argv[2]}: ${e.message}`);
    console.error(`brain: ${e.message}`);
    process.exit(process.argv[2] === 'hook' ? 0 : 1); // never fail a hook
  });
}
