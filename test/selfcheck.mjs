// Self-check for the parts that need no model call. Run: node test/selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRAIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
const b = await import('../bin/brain.mjs');
b.ensureHome();

// fit keeps the first item and the newest ones
assert.deepEqual(b.fit(['a', 'b', 'c'], 100), ['a', 'b', 'c']);
const fitted = b.fit(['first', 'xxxxxxxxxx', 'yyyyyyyyyy', 'last'], 12);
assert.equal(fitted[0], 'first');
assert.equal(fitted.at(-1), 'last');
assert.match(fitted[1], /earlier items skipped/);

// project resolution honours ignore list and aliases
const cfg = { aliases: { 'my-app': 'app' }, ignore: ['scratch-workspaces'] };
assert.equal(b.resolveProject('C:\\x\\scratch-workspaces\\abc', cfg), null);
assert.equal(b.resolveProject(path.join(os.tmpdir(), 'My App'), cfg).name, 'app');

// digest: human prompts, last reply per turn, edited files, failed commands, idle gaps
const t0 = Date.parse('2026-11-23T10:00:00Z');
const at = (m) => new Date(t0 + m * 60e3).toISOString();
const cwd = 'D:\\proj';
const recs = [
  { type: 'user', timestamp: at(0), cwd, message: { content: 'add login <system-reminder>noise</system-reminder>' } },
  { type: 'assistant', timestamp: at(1), cwd, message: { content: [
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'D:\\proj\\src\\login.js' } },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
  ] } },
  { type: 'user', timestamp: at(2), cwd, message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: '1 failing' }] } },
  { type: 'assistant', timestamp: at(3), cwd, message: { content: [{ type: 'text', text: 'Login added, one test fails.' }] } },
  { type: 'assistant', timestamp: at(4), cwd, isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
  { type: 'user', timestamp: at(60), cwd, message: { content: [{ type: 'text', text: 'fix the test' }] } },
  { type: 'assistant', timestamp: at(62), cwd, message: { content: [{ type: 'text', text: 'Fixed.' }] } },
];
const d = b.digestRecords(recs);
assert.deepEqual(d.prompts, ['add login', 'fix the test']);
assert.deepEqual(d.replies, ['Login added, one test fails.', 'Fixed.']);
assert.deepEqual(d.files, [path.join('src', 'login.js')]);
assert.equal(d.failed.length, 1);
assert.match(d.failed[0], /npm test → 1 failing/);
assert.equal(d.minutes, 10); // 3 + 5 (60-min gap capped) + 2
const txt = b.renderDigest('proj', d, '');
assert.ok(txt.length < 1000 && !txt.includes('noise') && !txt.includes('subagent'));

// model output is coerced to the card shape and limits
const n = b.normalizeUpdate({ did: 'x', next: ['1', '2', '3', '4', '5', '6', 7, ''], mood: 'weird' });
assert.equal(n.next.length, 5);
assert.deepEqual(n.broken, []);
assert.equal(n.mood, 'exploring');
assert.deepEqual(b.normalizeUpdate(null).decisions, []);

fs.rmSync(process.env.BRAIN_HOME, { recursive: true, force: true });
console.log('selfcheck ok');
