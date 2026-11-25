# Agent Deck

A colorful terminal deck for watching and steering Claude Code agents: every live session, its subagents, and what each one is doing right now.

Needs Node 20+ and the `claude` CLI on your PATH. No keys or secrets: it uses your existing Claude Code login.

```
git clone git@github.com:jasrajabov/agent-deck.git
cd agent-deck && npm install
npm start            # from this folder
npm link             # or link it, then run `agent-deck` anywhere
```

## What it shows

- **Sessions** from `claude agents --json --all`: interactive (`cli`) and background (`bg`), sorted so the ones that need you come first.
- **Subagents** nested under the session that spawned them (from `~/.claude/projects/<project>/<session>/subagents`).
- **Detail pane**: where it runs, uptime, a background job's current status line, token usage, and recent activity: your prompts (›), Claude's replies (◆) and tool calls (⚙).
- **Icons**: 💻 interactive and 🚀 background sessions; each subagent type keeps its own icon and colour (🔭 Explore, 🧭 Plan, 🤖 general-purpose, 🔍 reviewer, 🎨 UX/design, 🧪 tester, 📈 perf, 🌐 web, 📘 guide; other types get a stable pick). Set `AGENT_DECK_ICONS=plain` if your terminal draws emoji badly.
- **Token usage**: every row shows its tokens (input + cache write + cache read + output), coloured by size. A session's detail shows calls, output, current context size, model, a stacked bar of the mix, and **who used what**: the main thread against each subagent. The **Usage** view (`5` or `u`) ranks sessions and agent types across everything listed.

Counts come from the `usage` Claude Code records on each model call in the transcripts, read incrementally (only new bytes each poll). Cache reads usually dominate the total, since every call re-reads the conversation; the "out" figure is what the model actually wrote. Plan limits (the 5-hour session %) aren't in those files, so they aren't shown.

Status colours: orange spinner = working, yellow ◐ = needs you, grey ○ = idle, green ✓ = done, red ✗ = failed, blue = subagent.

## Keys

| Key | Does |
|---|---|
| ↑ ↓ / j k | Move |
| ← → / h e | Fold / unfold a session's subagents |
| ⏎ / a | Attach to a background session (`claude attach`); detach to come back |
| l | Full history of the selected session or subagent |
| x | Stop a background session (asks first) |
| d | Remove a finished background session (asks first) |
| n | Start a new background agent (`claude --bg`), in the selected session's folder |
| / | Search names, folders and subagent tasks |
| tab, 1–5 | Views: All, Active, Background, Done, Usage |
| u | Toggle the Usage view |
| r | Refresh now (it also refreshes every 2 s) |
| q | Quit |

In the new-agent prompt: tab / shift+tab picks the folder, ↑↓ recalls prompts sent this run, ←→ moves the cursor, ⌥←→ by word, ⌃A / ⌃E jump to start / end, ⌃W deletes a word, ⌃U / ⌃K clear before / after the cursor. Pasted newlines become spaces. Search uses the same editing keys.

Attach, stop and remove only work on background sessions: an interactive session belongs to the terminal it runs in.

## How it reads data

Only through Claude Code's own scripting surface (`claude agents --json`, `attach`, `stop`, `rm`, `--bg`) plus the transcript and metadata files Claude Code writes under `~/.claude`. Those file formats aren't a public API, so a Claude Code update can change them; `src/data.ts` is the one place to fix.
