# Agent Cockpit

A local cockpit for the coding-agent CLIs you already pay for. It runs several Claude Code and Codex conversations in parallel, shows which ones need you, lets you answer approvals from the browser, and keeps every thread on your own disk.

It does no AI inference of its own. It drives the official CLIs headless, and usage counts against your own subscriptions.

## How it works

```
Cockpit.app window or browser (React) ──SSE / JSON──► local server (Node, 127.0.0.1)
                                   ├─ claude -p  (stream-json in/out, approvals over stdio)
                                   ├─ codex app-server   (JSON-RPC over stdio)
                                   └─ ~/.agent-cockpit/threads/<id>/{meta.json, events.jsonl, messages.md}
```

- **Adapters** (`server/agents/<agent>/`) turn each CLI's wire protocol into one `NormalizedEvent` union (`server/agents/types.ts`).
- **Flags are allowlisted.** `flags.ts` builds argv from a zod schema, so the UI can never pass raw arguments.
- **Hooks are off by default** in cockpit threads (`disableAllHooks`), so SessionStart instructions don't hijack every spawned session. Threads can opt in.
- **Thread data lives in `~/.agent-cockpit/`**, outside this repo.

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | typecheck, unit tests, web build |
| `npm run smoke:claude` | real two-turn Claude run on Haiku; the second turn resumes the first by session id |
| `tsx scripts/proof-ui.ts <mode> [dir]` (modes: parallel, approvals, interrupt, reload, switch) | drives the real UI in headless Chrome and saves screenshots to `docs/proof/` |
| `npm run smoke:codex` | same resume check against `codex app-server` (default model `gpt-5.6-luna`, override with `COCKPIT_CODEX_MODEL`) |
| `npm start` | serve the cockpit on http://127.0.0.1:4317 |
| `npm run app` | build, then open the desktop app from the repo (DevTools in the View menu) |
| `npm run package` | build `release/mac-arm64/Cockpit.app` and `release/Cockpit-0.1.0-arm64.dmg` (ad-hoc signed, personal use) |
| `npm run proof:app` | Phase A gate: drives the packaged app with a bare launchd PATH, runs a Haiku thread to Done, quits mid-turn, checks no agent survives |
| `npm run icon` | regenerate `build/icon.icns` from `build/icon.svg` |

## Desktop app

`Cockpit.app` is the same server in Electron's main process (`electron/main.ts` → `server/start.ts`), on a random 127.0.0.1 port, with a native window around the page. Nothing about the API changes: the page still talks HTTP/SSE through the loopback guard.

- **Preload** exposes only `window.cockpit.{platform, pickFolder}`. The page runs with `contextIsolation`, `sandbox` and no Node; other URLs open in the default browser; web permission requests are denied.
- **PATH:** a Finder/Dock launch gets launchd's bare PATH, so at startup the app asks the login shell (`$SHELL -ilc`) for its PATH and merges it in (`electron/shell-path.ts`), with Homebrew/npm fallbacks if the shell can't answer.
- **Quitting** stops every agent before exit: stdin EOF, SIGTERM after 1.5s (an agent mid-turn), SIGKILL after 3s (`server/agents/stop.ts`). Closing the window keeps the app and its agents running, per macOS convention.
- Install: `cp -R release/mac-arm64/Cockpit.app /Applications/`. It's ad-hoc signed, not notarized, so the first launch may need right-click → Open.

## Protocol notes (verified against claude 2.1.283)

- Approvals need **both** `--permission-prompts host` and `--permission-prompt-tool stdio`. Without the second flag, every prompt is silently denied.
- A permission request arrives as `control_request{request:{subtype:"can_use_tool", tool_name, input, permission_suggestions}}`. The answer is `control_response{response:{subtype:"success", request_id, response:{behavior, updatedInput|message}}}`.
- Hook settings **merge** across sources: `--settings '{"hooks":{"SessionStart":[]}}'` does not silence existing SessionStart hooks (13 still fired in testing). Only `disableAllHooks` turns them off, which is why cockpit threads default to it.
- Approving must echo the original tool input as `updatedInput`; an empty object replaces it.
- An interrupt ends the turn with a failed `result`; the manager records it as `stopped` so it isn't shown as an error.
- `rate_limit_event` carries the five-hour limit status and `resetsAt`, which the usage badge uses.

## Codex notes (verified against codex-cli 0.147)

- Protocol: `initialize` → `initialized` → `thread/start` (or `thread/resume {threadId}`) → `turn/start`. No `jsonrpc` field. Codex assigns its own thread id, and the manager adopts it from the `session` event.
- Approvals arrive as server requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) and are answered with `{decision: accept | acceptForSession | decline}`.
- Cockpit permission modes map to approval policy + sandbox: manual/acceptEdits → on-request + workspace-write, plan → read-only, auto/dontAsk → never + workspace-write, bypassPermissions → never + danger-full-access.
- If `~/.codex/config.toml` pins a model newer than the installed CLI supports, every turn fails with a 400 error. Set a model on the thread, or upgrade the CLI.

## Switching agents

`POST /api/threads/:id/agent` closes the current session, appends an `agent_switch` event, and gives the thread a fresh session id. The next message starts a new session, seeded with the transcript so far (`server/threads/handoff.ts`): through `--append-system-prompt` for Claude and `developerInstructions` for Codex. Provider-side history isn't transferred; the files on disk and the transcript are the handoff.
