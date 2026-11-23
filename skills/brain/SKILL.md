---
name: brain
description: Progress tracker across all my projects. Use for "/brain", "what should I work on today", "daily/weekly report", "what's waiting on me", or to add a progress note.
---

Run the brain CLI and show its output to the user as-is. Do not read brain's data files yourself.

CLI: `node "<this skill's base directory>/../../bin/brain.mjs" <command>`

| User says | Command |
|---|---|
| `/brain`, "today", "what should I do" | `status` (if it says no report yet, run `daily`) |
| "refresh", `/brain now` | `daily` |
| "week", "weekly review" | `week` |
| "card for X", "status of X" | `status <project>` |
| "all projects" | `list` |
| "note …", "log …" | `note [--project <name>] <text>` |

`daily` and `week` first catch up any uncaptured sessions, then make one report call. They can take several
minutes on the first run, so run them with a 600000 ms timeout. `status`, `list` and `note` make no model call.
