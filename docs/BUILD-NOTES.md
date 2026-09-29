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

- 111 unit tests across 15 files.
- Real-agent smokes for Claude, Codex and the cockpit MCP, and a proof gate for every phase (browser proofs for phases 1 to 3, packaged-app proofs from Phase A on).
- One commit per phase or checkpoint; see `git log`.

## Re-verification after Phase 5 (2026-09-29)

The reliability checkpoint rewrote parts of the thread manager, and its Claude checks had failed with empty replies. They ran while the Claude account was at its usage limit; after the reset, `npm run smoke:claude` passed (resume recalled the codeword), and every Claude gate was re-run on a fresh package: `proof:app` 10/10, `proof-b` b1 11/11, b2 12/12, b3 17/17, `proof:mcp` 16/16, `proof:reliability`, and `smoke:mcp claude`.

`proof:mcp` was tightened on the way. In one run Haiku also used Bash, which correctly asked for approval in manual mode, and the old check ("only starting a process asks") failed on it. The check now asserts what it was meant to: starting a process asks, and the read-only cockpit tools never do. Approval details are logged in the check output.

Also fixed: the composer's `@ Workflow` picker had lost the inset of the chip it replaced and sat on the card border.

## Next

Phone access, then the in-app preview pane. Workflows, schedules and the Files panel are now implemented. See the roadmap in the [README](../README.md).


## Reliability checkpoint after Phase 4 (2026-09-29)

**What.** Fixed four issues found in review before starting workflows and scheduling.

- Agent callbacks belong to one process generation. An old process's delayed exit, result, or session notification cannot remove or overwrite its replacement. Shutdown also waits for sessions already closing after a switch.
- Approval cards use fresh public IDs mapped to the current session's wire IDs and original inputs. Responses to expired or already answered requests are rejected. Turn/session boundaries clear pending approvals, including when resuming after an unclean application exit.
- Conversation loads check both selection and request generation. Selecting another conversation clears the old detail, shows a loading state, and prevents the old composer from acting on the wrong thread. Reconnect loads use the same guard.
- Completing, reopening, or sending a message to a completed thread broadcasts the metadata change, updating the header and list filters immediately.

**Gate.** `npm run verify`: 97 tests, typecheck, and both builds passed. `npm run package` produced the app and DMG. `npm run proof:reliability` passed against the packaged app with synthetic threads: delayed response ordering, correct message target, repeated selection, completion/reopening, filtering, and deselection. This proof makes no agent calls. Manager regressions cover delayed process callbacks, shutdown, reused approval IDs, expired approvals, restart, and completion notifications.

**Live integration.** `npm run smoke:codex` passed both turns and resumed the codeword correctly. `npm run smoke:claude` returned empty replies and failed; the script did not expose a reason. No retry was made. Claude live integration remains unverified for this checkpoint; rerun `npm run smoke:claude` when the CLI/session issue is resolved. Real-agent approval and MCP proofs were not rerun in this checkpoint.

**Next.** Phase 5: saved workflows, scheduling, and `save_workflow`; then phone access and the embedded preview pane. The existing Files and Workflows UI sections remain placeholders.

## Phase 5a: workflow storage, execution and scheduling

Workflows are stored atomically in `workflows.json` under the Cockpit state directory, scoped to a project. Each saves a name, instructions, agent settings, an optional interval, and its latest conversation/error. Editing pauses its schedule. Archiving retains the saved record.

`@workflow:name` expands reusable instructions from the same project into one agent turn. Nested references have cycle, depth, count and size limits. These are instruction references, not separate dependent agent jobs.

The scheduler checks every five seconds while Cockpit is running. Intervals are 5 minutes to 30 days. It records the next due time before launching, runs at most once after downtime, skips workflows already working or awaiting approval, and pauses after a failed scheduled run. A crash between recording the due time and launching can skip that occurrence; the policy prefers avoiding duplicate work. Closing Cockpit stops the scheduler.

`save_workflow` is an approval-gated MCP tool. It creates an unscheduled workflow in the calling session's project with default manual permissions; agents cannot activate schedules through it. HTTP routes also support manual runs, editing, scheduling and archival. Every run creates a normal conversation with workflow provenance.

Gate: `npm run verify` passed with 106 tests. Tests use fake agents for deterministic scheduling and exercise the actual HTTP/MCP routes. The Workflows UI follows in Phase 5b. Live Claude validation remains blocked by the previously recorded empty-reply failure; it was not retried.

## Phase 5b: workflow editor and live desktop proof

The Workflows tab now lists and edits project workflows with agent, model, permissions and repeat interval. Save pauses a schedule, Save and run opens its new conversation, and Save and enable schedule activates recurrence explicitly. Users can pause, archive, and open the latest run. The conversation composer inserts `@workflow:name` references from the current project.

Gate: 106 unit tests and builds passed. `npm run proof:workflows` ran the packaged app with a synthetic project and real Codex on the configured small model: a manual workflow and a due scheduled workflow both completed with the expected response. Composer insertion, pause, archive and the 980px desktop layout passed. Light/dark screenshots are in `proof/phase-5-workflows*.png`. No Claude retry was made. Files is the remaining Phase 5 panel.


## Phase 5c: project files and conversation attachments

The Files tab browses one directory at a time, previews UTF-8 text, and adds an encoded `@file:relative-path` reference to the selected conversation draft (or the new-conversation draft). Existing draft text is preserved. The composer attachment button opens Files. References are resolved on send, so the agent receives current file contents; workflows can use the same references on each run. Expansion happens before launching the agent, and failed submissions retain the draft and show the error.

File reads require project containment after resolving symbolic links, reject path traversal and outside links, and are bounded to 100 KB per file, eight attachments, and 200,000 total characters. Directory listings cap at 500 entries and omit `.git`, dependencies, build outputs and symbolic links. Binary, invalid UTF-8 and non-regular files are rejected. File contents are not recursively interpreted as workflow or file references.

Gate: `npm run verify` passed with 111 tests, and packaging succeeded. `npm run proof:files` passed against the packaged app with synthetic data and no agent calls: browsing, binary rejection, a filename with spaces, draft preservation through reload, failed-send recovery, attaching to the existing conversation, correct message target, minimum desktop width and dark mode. Screenshots: `proof/phase-5-files.png` and `proof/phase-5-files-dark.png`. Unit/HTTP tests verify containment, limits and the expanded text delivered to fake agents. Phase 5 is complete; Phase 6 phone access is next.
