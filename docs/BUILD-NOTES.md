# Build notes

How Cockpit was built, phase by phase: what each phase added, how, why, and the gate it had to pass. Every phase ended with `npm run verify` green and a proof run against real agents. From Phase A on, proofs ran against the packaged app, not a dev build. Screenshots from each gate are in [proof/](proof/).

## Where it started

Desktop GUIs for coding agents are appearing, usually as a paid subscription on top of the agent subscriptions you already have. Cockpit started by studying one of them, Enjoy, from the outside: its public site, release notes and the app bundle, inspected statically. Three things were worth having on my own machine and terms:

1. Parallel conversations with their status visible at a glance: working, needs you, done.
2. Switching a conversation to another agent when a usage limit hits, with the context carried over.
3. Scheduled, chainable workflows that land as conversations you can answer from your phone.

The plan was a personal V1 in small phases, each with a proof gate that has to pass on this machine before the next starts. The heavy parts of a commercial product (installers for every platform, accounts, billing, a relay, onboarding) were left out on purpose.

## Phase 0: Claude adapter

**What.** Spawn `claude -p` in stream-json mode, parse its events, answer its permission prompts, and shut it down cleanly.

**How.** `server/agents/claude/flags.ts` builds argv from a zod schema, so the UI can never inject a raw flag. `parse.ts` maps stream-json lines to a small `NormalizedEvent` union. Recorded real sessions became test fixtures.

**Why.** Everything else sits on this. The union is what later let Codex slot in without touching storage or UI.

**Gate.** A two-turn conversation where the second turn runs in a new process and resumes the first by session id, on Haiku (`npm run smoke:claude`).

## Phase 1: Threads, server and UI

**What.** A thread store on disk, a manager for live sessions, an HTTP + SSE server and a first React UI.

**How.** Each thread is `meta.json`, append-only `events.jsonl` and a readable `messages.md` under `~/.agent-cockpit/`. Status is derived from the event log. One SSE stream carries every thread's updates; the page filters. The server binds to 127.0.0.1 behind a guard that checks Host, Origin and content type, because any web page in a browser can reach localhost.

**Why files.** No database to run, threads survive a restart, and the transcript is a file you or an agent can read.

**Gate.** Three threads running in parallel with correct statuses, and a thread picked up again after a server restart, driven through the real UI in headless Chrome.

## Phase 2: Approvals and stop

**What.** Tool approvals answered from the UI (Allow, Allow for session, Deny), and Stop.

**How.** Found by testing: approvals need both `--permission-prompts host` and `--permission-prompt-tool stdio`, and approving has to echo the tool's original input. Stop is an interrupt request; the failed result that follows is recorded as a stop, not an error. Also found: hook settings merge across sources, so only `disableAllHooks` keeps personal SessionStart hooks out of cockpit sessions.

**Gate.** Approve and deny real tool calls from the UI; interrupt a running turn without it showing as an error.

## Phase 3: Codex and switching agents

**What.** A second adapter for `codex app-server`, and switching a thread between agents mid-conversation.

**How.** Codex speaks JSON-RPC over stdio (`server/agents/codex/rpc.ts`). Its approvals are server requests answered with accept, acceptForSession or decline. Cockpit's permission modes map onto Codex's approval policy plus sandbox. A switch closes the current session, records an `agent_switch` event, and seeds the next session with the transcript so far (`server/threads/handoff.ts`).

**Why this way.** Neither provider can import the other's history. The files on disk are the shared memory, so the handoff is the transcript.

**Gate.** Switch Claude to Codex mid-thread and Codex continues the task correctly; Codex resumes across processes (`npm run smoke:codex`).

## Phase A: A real Mac app

**What.** `Cockpit.app`, built and packaged, instead of a page on localhost.

**How.** The server was refactored into `startServer()` so Electron's main process can run it unchanged on a random port, and the window loads it. The page runs sandboxed with no Node; the preload exposes a folder picker and little else. electron-builder produces an ad-hoc signed app and DMG, with an icon of our own.

**Why Electron.** Tauri would have needed either a bundled Node sidecar (cancelling its size advantage) or a Rust rewrite of a proven backend. Electron runs the existing server as is.

**Found by the gate.** A Finder launch gets launchd's bare PATH, so `claude` wasn't found; the app now asks the login shell for PATH at startup. And quitting with an agent mid-turn could leave the agent running; closing a session is now stdin EOF, then SIGTERM, then SIGKILL, and quit waits for it.

**Gate** (`npm run proof:app`). Launch the packaged app with a bare PATH, run a Haiku thread to Done, quit with a second agent mid-turn, and confirm by pid that no agent survived.

## Phase B: The interface (B1 to B3)

**What.** A full conversation UI: project tab bar with live badges, conversation list with filters and counts, thread view with activity lines and inline approvals, composer with an agent picker, dark mode.

**How.** Design tokens were measured from reference screenshots and written fresh as CSS `light-dark()` pairs. The name, mark, illustrations and copy are Cockpit's own. `web/src/transcript.ts` is a pure function that turns the raw event log into messages, one timed activity line per tool call ("Reading package.json"), and approval cards, so it's unit-tested without a browser.

**Fixed along the way.** The page re-subscribed to SSE on every list change and could drop events during the reconnect; it now subscribes once and re-reads on reconnect. Opening a thread mid-turn only showed text streamed after opening; the server now keeps the in-progress message.

**Gate** (`tsx scripts/proof-b.ts b1|b2|b3`). On the packaged app with real Haiku threads in working, needs-you and done states: every control exercised, states checked through the API, screenshots compared against the reference by eye.

## Phase 4: Cockpit MCP and the process runner

**What.** Agents can start a dev server, read its log and open the preview on their own, and you can see and stop what they started.

**Scope decision.** The original spec assumed a process runner, a preview pane and a workflow store that didn't exist yet. Phase 4 built the runner, made `open_preview` open the default browser for now (it becomes an in-app pane later), and moved `save_workflow` to the workflows phase.

**4a, process runner** (`server/processes/`). Each command runs as its own process group, because dev commands fork and killing only the direct child leaves the server holding its port. Output is split into numbered lines, stripped of terminal codes, capped at 512 KB, and the first local URL it prints is detected. Stop is SIGTERM to the group, then SIGKILL after 3 s; quitting the app stops them all.

**4b, the MCP** (`server/mcp/`). A stdio MCP server built with the official SDK is attached to every Claude and Codex session. It exposes `start_process`, `stop_process`, `list_processes`, `read_process_output` and `open_preview`, and calls back to the cockpit over HTTP with a per-session token.
- *Why a token.* Not secrecy (any local process can already reach the API) but identity and scope: a session's tools only see its own project, and stop working when the session ends.
- *How it travels.* Through the agent's environment, never argv. Tested first: Claude's MCP servers inherit the agent's env; Codex forwards only variables named in `env_vars`.
- *How it runs.* The app's own binary with `ELECTRON_RUN_AS_NODE=1`, reading the bundled script from inside `app.asar`, so no Node install is needed.
- *Approvals.* Reading and previewing are pre-allowed; starting and stopping a process ask, like a shell command. Codex asks through an MCP elicitation, which Cockpit renders as the same approval card.
- *Guidance.* One line in the system prompt says to use `start_process` for anything long-running.

**4c, UI and gate.** A chip under the conversation title (`1 process · :5173`) opens the project's processes with their URL and a Stop button. Cockpit tool calls read as plain activity lines ("Starting npm run dev", "Opening the preview").

**Gate** (`npm run proof:mcp`, 15 checks). The packaged app, a real Haiku conversation in a small web project, and a prompt that names no tools: "Get this project's dev server running, check its log for errors, and show me the site." The agent had to start the server through Cockpit, read its log and open the preview itself, and the site had to actually be served. Then: Stop from the UI kills the whole server, the agent restarts it on request, and quitting the app leaves none of its processes alive. The same task passes on Codex (`npm run smoke:mcp codex`).

## Numbers

- 92 unit tests across 13 files.
- Real-agent smokes for Claude, Codex and the cockpit MCP, and a proof gate for every phase (browser proofs for phases 1 to 3, packaged-app proofs from Phase A on).
- One commit per phase or checkpoint; see `git log`.

## Next

Workflows and schedules (with `save_workflow`), phone access, and the in-app preview pane. See the roadmap in the [README](../README.md).
