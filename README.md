# Cockpit

**A desktop cockpit for the coding agents you already pay for.** Run several Claude Code and Codex conversations side by side, see at a glance which ones are working and which ones need you, answer their approvals inline, and switch a conversation from one agent to the other when a usage limit hits. Agents can start your dev server, read its logs and open the preview on their own.

Cockpit does no AI inference itself. It drives the official `claude` and `codex` CLIs headless, so usage counts against your own subscriptions, and every conversation stays on your own disk as plain files.

![A Cockpit conversation: the agent started the dev server, read its log and opened the preview; the running process shows under the title](docs/proof/phase-4-thread.png)

## Features

- **Parallel conversations, grouped by project.** A tab per pinned project, each showing how many agents are working and how many need you. The list filters by All, Needs you, Working and Unread, with live counts and search.
- **Approvals where you are.** When an agent asks to run a command or edit a file, the request appears as a card in the conversation: Allow, Allow for this session, or Deny.
- **Two agents, one thread.** Pick Claude Code or Codex, the model, effort and permission mode per conversation. Switch agent mid-thread and the transcript is handed over to the new one.
- **Dev servers the agent can see.** Every agent session gets a built-in `cockpit` MCP server. The agent starts long-running commands through it, reads their output, and opens the local preview for you. Running processes show under the conversation title, with the URL and a Stop button.
- **Repeatable workflows.** Save project instructions and agent settings, run them manually or on a repeating interval, and open each run as a conversation. Schedules run while Cockpit is open and pause on failure.
- **Project files in the conversation.** Browse and preview text files, then attach their current contents to a new or existing conversation draft.
- **Files first.** Each conversation is `meta.json`, `events.jsonl` and a readable `messages.md` under `~/.agent-cockpit/`. Nothing leaves your machine except what the CLIs themselves send.
- **A real Mac app.** Native window, runs from Finder or the Dock, and quitting stops every agent and dev server it started.

## Quick start

Requirements: macOS on Apple silicon, Node 22+, and the CLIs you want to use, signed in: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) and/or [Codex](https://github.com/openai/codex) (`codex`).

```bash
git clone https://github.com/Holodeck23/agent-cockpit.git
cd agent-cockpit
npm install
node node_modules/electron/install.js   # Electron's binary, if your npm blocks install scripts

npm run app        # build and open the desktop app from the repo
```

To build and install the app:

```bash
npm run package
cp -R release/mac-arm64/Cockpit.app /Applications/
```

The build is ad-hoc signed, not notarized, so the first launch may need right-click, then Open.

Prefer a browser? `npm start` serves the same UI at http://127.0.0.1:4317.

## How it works

```
Cockpit window (React) ──HTTP + SSE──►  local server (Node, 127.0.0.1, random port)
                                         ├─ claude -p          stream-json over stdio, approvals over stdio
                                         ├─ codex app-server   JSON-RPC over stdio
                                         ├─ process runner     dev servers, one process group each
                                         └─ ~/.agent-cockpit/  threads as plain files
         each agent session ──stdio──►  cockpit MCP server ──HTTP + session token──► local server
```

- **Adapters** turn each CLI's wire protocol into one event model, so threads, storage and UI never care which agent is talking.
- **Nothing raw reaches a command line.** Every flag passed to a CLI is built from a schema allowlist.
- **The server only answers its own page.** Loopback host, matching origin and JSON-only writes, so a website open in your browser can't drive your agents.
- **The desktop app is the same server** in Electron's main process, with a sandboxed page and no Node in the renderer.

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The CLI protocol details that took testing to find are in [docs/PROTOCOLS.md](docs/PROTOCOLS.md), and the build history, phase by phase with what and why, is in [docs/BUILD-NOTES.md](docs/BUILD-NOTES.md).

## The cockpit MCP

| Tool | What it does | Asks first |
|---|---|---|
| `start_process` | Runs a command such as `npm run dev` in the project and waits for its URL or first output | Yes |
| `stop_process` | Stops it and everything it spawned | Yes |
| `list_processes` | The project's processes, status and URL | No |
| `read_process_output` | The log, incrementally | No |
| `open_preview` | Opens a local page (localhost only) for you | No |
| `save_workflow` | Saves reusable instructions in the current project, with scheduling off | Yes |

Each session's tools are scoped to that session's project by a token that ends with the session. The token is passed through the agent's environment, never on a command line.

## Workflows and files

Open **Workflows** to save instructions, choose an agent and permissions, and run the job. To repeat it, set an interval (5 minutes to 30 days) and choose **Save and enable schedule**. Saving edits pauses the schedule. Runs already working or waiting for approval are skipped; after downtime, at most one missed run is started. Cockpit must remain open for schedules to run.

Use `@workflow:daily-review` to include another saved workflow's instructions in the same turn. References stay within the project and cycles are rejected. This combines instructions; it does not create separate dependent agent jobs.

Open **Files**, or use the composer's attachment button, to preview a text file and add it to your draft. `@file:src%2Fhello%20world.ts` is an encoded relative path; the picker handles encoding. Files are read again when sent, including during scheduled workflow runs. Text files are limited to 100 KB each, eight attachments and 200,000 characters per expanded prompt. The conversation keeps your message as written, with each attachment shown by name; the file contents go to the agent only. A reference counts only at the start of a word, so an address like `a@file:x` is sent as plain text. A missing or badly encoded file stops the send with a short message and keeps your draft.

## Development

| Command | What it does |
|---|---|
| `npm run verify` | Typecheck, unit tests, web and Electron builds |
| `npm start` | Serve the UI at http://127.0.0.1:4317 |
| `npm run app` | Build and open the desktop app from the repo |
| `npm run package` | Build `release/mac-arm64/Cockpit.app` and a `.dmg` |
| `npm run smoke:claude` / `smoke:codex` | Real two-turn run that resumes across processes |
| `npm run smoke:mcp [claude\|codex]` | Real agent, dev-server task: must use the cockpit tools on its own |
| `npm run proof:app` | Packaged app from a bare Finder PATH: a Haiku thread to Done, quit mid-turn, no agent left running |
| `tsx scripts/proof-b.ts b1\|b2\|b3` | Packaged app UI gates with screenshots |
| `npm run proof:reliability` | Packaged app with synthetic threads: delayed loads, message routing, completion and reopening; no agent usage |
| `npm run proof:workflows` | Packaged app: real Codex manual and scheduled workflow runs, editor and schedule controls |
| `npm run proof:files` | Packaged app: synthetic file browsing, preview, draft attachments and failed-send recovery; no agent usage |
| `npm run proof:mcp` | Packaged app: agent starts, reads and previews the dev server unprompted; Stop, restart, clean quit |
| `npm run proof:phone` | Packaged app and real Tailscale on HTTPS 8443: turn on phone access, pair a phone-sized Chrome, and refusals for a login not on the allowlist, the LAN address, no identity, a foreign Origin, an unpaired and a removed phone, each with a control |

Proofs and smokes use real agents on small models (Claude Haiku, a light Codex model), so they cost a few cents each. Screenshots land in [docs/proof/](docs/proof/).

## Status and roadmap

Built and proven: Claude and Codex adapters, parallel threads, approvals, stop, agent switching with handoff, the desktop app, the full conversation UI, the cockpit MCP with the process runner, workflows and schedules, file attachments, and phone access over Tailscale with pairing.

Next:
1. **Phone, continued.** A phone-sized layout, "needs you" notifications, and answering a real approval from the phone.
2. **Preview pane.** `open_preview` opens inside the app, and the agent can check its own UI change with a screenshot.

## Credits

The layout and interaction model are inspired by [Enjoy](https://enjoy.dev), a commercial desktop app for coding agents. Cockpit's name, mark, illustrations, copy and code are its own. No code or assets were taken from Enjoy.
