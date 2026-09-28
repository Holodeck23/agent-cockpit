# Agent Cockpit

A local cockpit for the coding-agent CLIs you already pay for. It runs several Claude Code and Codex conversations in parallel, shows which ones need you, lets you answer approvals from the browser, and keeps every thread on your own disk.

It does no AI inference of its own. It drives the official CLIs headless, and usage counts against your own subscriptions.

## How it works

```
browser (React) ──SSE / JSON──► local server (Node, 127.0.0.1)
                                   ├─ claude -p  (stream-json in/out, approvals over stdio)
                                   ├─ codex app-server   (phase 3)
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
| `tsx scripts/proof-ui.ts <parallel|approvals|interrupt|reload> [dir]` | drives the real UI in headless Chrome and saves screenshots to `docs/proof/` |
| `npm start` | serve the cockpit on http://127.0.0.1:4317 |

## Protocol notes (verified against claude 2.1.283)

- Approvals need **both** `--permission-prompts host` and `--permission-prompt-tool stdio`. Without the second flag, every prompt is silently denied.
- A permission request arrives as `control_request{request:{subtype:"can_use_tool", tool_name, input, permission_suggestions}}`. The answer is `control_response{response:{subtype:"success", request_id, response:{behavior, updatedInput|message}}}`.
- Hook settings **merge** across sources: `--settings '{"hooks":{"SessionStart":[]}}'` does not silence existing SessionStart hooks (13 still fired in testing). Only `disableAllHooks` turns them off, which is why cockpit threads default to it.
- Approving must echo the original tool input as `updatedInput`; an empty object replaces it.
- An interrupt ends the turn with a failed `result`; the manager records it as `stopped` so it isn't shown as an error.
- `rate_limit_event` carries the five-hour limit status and `resetsAt`, which the usage badge uses.
