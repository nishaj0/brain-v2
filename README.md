# brain (v2, working name)

A local progress tracker for one developer running several projects with Claude Code.
It answers "what should I work on today, what's waiting on me, what did I do this week" without Jira or Linear.

Everything stays on your machine in `~/.brain/`. No server, no git, no account.

## How it works

1. **Capture (per session, automatic).** When a Claude Code session ends or is about to compact, a hook starts a
   background job. The job trims the transcript to a digest of about 3k tokens: your prompts, Claude's last reply of each turn,
   edited files, failed commands and git commits. It sends that digest plus the project's current card to Haiku, which returns
   the updated card: what was done, next steps, waiting on you, what Claude can do, broken items and decisions.
   Your session is never slowed down, and nothing is injected into your context.
2. **Daily report (one Haiku call).** Reads all cards, the last 24 hours of events, your notes and `goals.md`, then writes
   Focus, Waiting on you, Claude can do, Skip today, Stale and Yesterday.
3. **Weekly review (one Sonnet call).** Reads cards, the last 7 daily reports and time per project, then writes
   ranked priorities, a NOW pick, next week's tasks and keep/park/kill calls.
4. **Catch-up.** `daily` and `week` first scan Claude Code's own session logs for anything the hook missed
   (crashed sessions, sessions from before you installed this).

## Measured cost (Haiku, fresh run on 21 real sessions, one turn per call)

| What | Tokens in / out | Cost |
|---|---|---|
| One session capture | ~4k–9.5k / ~1–4k (avg 6.4k / 2.1k; ~4k of the input is fixed CLI overhead) | ~$0.002 |
| Daily report | ~10k / ~2k | ~$0.003 |
| First `daily` after install (catches up the last 2 days) | 21 captures + report | $0.044, ~5 min |

Every model call is logged with its tokens and cost in `~/.brain/brain.log`.

## Install

Needs Node.js 18+ and Claude Code. Clone this repo, then:

```powershell
claude plugin marketplace add D:\MyProjects\brain-v2
claude plugin install brain@brain-local
```

Then restart Claude Code. To try it without installing: `claude --plugin-dir D:\MyProjects\brain-v2`.

## Use

In any Claude session: `/brain:brain` (today), `/brain:brain now` (refresh), `/brain:brain week`,
`/brain:brain note shipped the paywall`. Plain questions also work, such as "what should I work on today?"

Or from a terminal:

```powershell
node D:\MyProjects\brain-v2\bin\brain.mjs status
```

| Command | Model call |
|---|---|
| `status [project]` shows today's report or one card | none |
| `list` shows all cards | none |
| `note [--project p] <text>` | none |
| `daily` | 1 Haiku, plus captures for missed sessions |
| `week` | 1 Sonnet, plus captures for missed sessions |
| `scan [days]` | 1 Haiku per missed session |

## Scheduled reports (optional)

Daily at 08:00 and weekly on Friday at 18:00, via Windows Task Scheduler:

```powershell
schtasks /Create /SC DAILY /ST 08:00 /TN "brain daily" /TR "node D:\MyProjects\brain-v2\bin\brain.mjs daily"
```

```powershell
schtasks /Create /SC WEEKLY /D FRI /ST 18:00 /TN "brain week" /TR "node D:\MyProjects\brain-v2\bin\brain.mjs week"
```

Reports land in `~/.brain/reports/`.

## Files in `~/.brain/`

| File | What |
|---|---|
| `cards/<project>.json` | Current state per project, fixed size, rewritten on each capture |
| `events.jsonl` | One line per session or note. Models only ever see the last 1–7 days |
| `captured.json` | Which transcript lines are already captured, so reruns are safe |
| `projects.json` | `aliases` (folder name → project name) and `ignore` (path substrings to skip) |
| `goals.md` | Optional priorities and deadlines. Every report reads it |
| `reports/` | `daily-YYYY-MM-DD.md`, `week-YYYY-MM-DD.md` |
| `brain.log` | Model calls, costs, errors |

Projects are named after the git repo root, so subfolders and Claude worktrees roll up into one project.
Folders that aren't git repos use the folder name.

## Settings (environment variables)

`BRAIN_HOME` (data folder), `BRAIN_CAPTURE_MODEL` (default `haiku`), `BRAIN_DAILY_MODEL` (`haiku`), `BRAIN_WEEK_MODEL` (`sonnet`).

## Model calls

They run as `claude -p --safe-mode --tools "" --no-session-persistence` with a short system prompt. They use your
Claude login, load no plugins, hooks or MCP servers (so there's no recursion and no extra context), have no tools,
and leave no transcript behind.

## Known limits

- It reads Claude Code's internal transcript format, which can change between versions. Failures show up in `brain.log`.
- Only Claude Code sessions are captured. Work in other tools only shows up through `note`.
- Single user, local only. Sync and teams come later.

## Test

```powershell
node D:\MyProjects\brain-v2\test\selfcheck.mjs
```
