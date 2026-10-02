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

- 115 unit tests across 15 files.
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


## Checkpoint after Phase 5: attachment references (2026-09-29)

**What.** Four defects from review of Phase 5c.

- **Stored text was the expanded text.** The server replaced `@file:` references with file contents before creating the conversation, so the title, the list card, the stored message and `messages.md` all held the file. Now the thread manager takes two texts: what the user wrote (stored, titled, previewed) and what the agent receives. The manager records the user's message itself; the Claude and Codex adapters only deliver the turn. `@workflow:` references had the same problem and use the same split, including scheduled and manual workflow runs, which now store the workflow's prompt as written.
- **Transcript size.** A message could store up to 8 files of 100 KB each. The transcript now shows attachments as one line under the message ("Attached: src/app.ts"), and `messages.md` does the same.
- **Agent switch.** The handoff carries the user's message with its attachments named, not a copy of the file from that moment. The files on disk are current; the copy was not.
- **Errors.** A missing file returned 500 with the raw `ENOENT` text and an absolute path; malformed percent-encoding returned 500 "URI malformed"; and a reference was matched mid-word, so `a@file:x` in normal text blocked sending. References now count only at the start of a word. Unknown files, bad encoding, too many attachments and unknown workflows return 400 with a short message that names the project-relative path only. The Files panel's own read and list errors use the same wording.

**Why the split lives in the manager.** Recording the user's message in each adapter meant every adapter had to be told which text to show. With the manager recording it, the stored message cannot differ between agents, and tests with fake agents exercise the real path.

**Gate.** `npm run verify`: 115 tests, typecheck and both builds. New tests cover the stored message, title, preview and `messages.md` over HTTP, each error case (and that no absolute path or raw error text is returned), mid-word text passing through untouched, the handoff, workflow runs, and the transcript view. `npm run proof:files` now ends with one real Haiku turn in the packaged app: it attaches a note holding a random codeword through the Files panel, asks for the codeword, and asserts the answer contains it with no tool calls (so it came from the attachment), while the stored message equals what was typed, and the title, `messages.md` and the message bubble do not contain the file. Screenshot: `proof/phase-5-files-attached.png`. Regression proofs re-run on the same package: `proof:app` 10/10, `proof-b` b1 11/11, b2 12/12, b3 17/17, `proof:mcp` 16/16, `proof:reliability` and `proof:workflows` all passed.


## Phase 6a: phone access over Tailscale (2026-09-29)

**What.** A Phone button in the sub-nav turns on phone access. Cockpit then serves the same page on `https://<mac>.<tailnet>.ts.net` through `tailscale serve`, and a phone signed in to the owner's Tailscale account can pair once and open it. The Mac shows each pairing request as a floating banner with a six-digit code to compare, and lists paired phones with a Remove button.

**How.** `server/remote/`:
- `guard.ts` checks every phone request: loopback socket, the tailnet Host (with the port when not 443), `X-Forwarded-Proto: https`, a `Tailscale-User-Login` on the allowlist, a matching Origin, JSON writes. It also holds the list of API routes the phone may use.
- `store.ts` keeps `remote.json` (enabled, port, HTTPS port, allowed logins, paired phones with hashed tokens) and the pending pairing requests in memory. A request lives five minutes, is redeemed once for a token, and asking again from the same phone reuses it.
- `tailscale.ts` wraps the CLI with a 15 second timeout on every call. When the macOS network extension is waiting for approval, `tailscale status` otherwise hangs forever.
- `service.ts` owns the phone listener, turns `tailscale serve` on and off, refuses to take over an HTTPS port that already serves something else, and resumes at launch if phone access was on.

**Why these choices.**
- *A second listener instead of widening the desktop guard.* Tailscale keeps the original Host, so the loopback guard rejects every phone request. Accepting the tailnet Host on the desktop listener would have mixed two trust models in one check.
- *Identity and pairing.* The identity header proves which Tailscale account is asking; pairing proves which phone, and lets a lost phone be removed. Tokens are bound to the login that paired them.
- *A fixed port.* `tailscale serve` persists its target, so the port has to survive restarts. 47821 by default, configurable in `remote.json`, along with the HTTPS port.
- *Separate Electron profile per state folder.* The proofs launch the packaged app with their own `COCKPIT_HOME`. With the owner's Cockpit running, the single-instance lock made those launches quit at once. A different state folder now gets its own Electron profile, so it is a separate instance.

**Found on the way.**
- Requests from the Mac to its own tailnet address carry the owner's identity too, so the positive path can be tested without a second device.
- On this Mac, a closed port on the LAN address times out instead of refusing (firewall stealth mode). "Unreachable" is only meaningful next to a control listener on every interface that IS reachable there, so both the unit test and the proof include one.
- With the Phone panel open, the pairing banner sat under it and showed the request twice. The banner now hides while the panel is open, and floats instead of taking a layout row.

**Gate.** `npm run verify`: 132 tests, including the guard's refusals each paired with a positive control, pairing, token binding and revocation over HTTP against a fake Tailscale, and the LAN control. `npm run proof:phone` on the packaged app through real Tailscale (HTTPS 8443, so an installed Cockpit on 443 is untouched): 17/17. A login not on the allowlist is refused through Tailscale; the owner is accepted; no identity, a foreign Origin, an unpaired phone and the tailnet Host on the desktop listener are refused; the LAN address cannot reach the phone port while a control listener can be reached there; a Pixel-sized Chrome pairs with the code shown on both screens, reads conversations, cannot start one in an arbitrary folder, and is refused again once removed; turning off removes the serve entry and closes the port. Screenshots mask the tailnet name, login and QR code: `proof/phase-6-phone-panel.png`, `phase-6-pairing-request.png`, `phase-6-phone-pair.png`. Also paired for real: the owner's Pixel 9a, over Tailscale, on the installed app.

**Regression.** All packaged proofs re-run on the same build: `proof:app`, `proof-b` b1/b2/b3, `proof:mcp` 16/16, `proof:reliability`, `proof:workflows`, `proof:files`. Two proof fixes on the way. `proof-b` looked up the theme button by class, which the new Phone button also carries; it now asks for the theme button by label. `proof:mcp` required a `read_process_output` call to count as "read its log", but in two runs Haiku got the log from `start_process` with `wait_seconds`, which returns the first output lines, and reported no errors from them. The check now accepts either tool when the result it received contains the dev server's own output.


## Phase 6b: phone layout and home-screen app (2026-09-29)

**What.** On a paired phone, Cockpit is a one-column app: a bar with the mark, Conversations only, every project's conversations in one list with the project named on each card, and a tapped conversation opening full screen with a back button. The phone can reply, answer approvals and stop a turn; it has no New conversation, attach, workflow mention, agent switch, mark complete or process controls, matching the routes the server allows it. Approval buttons are full width and at least 44px tall. The page carries a web app manifest (standalone, maskable icons from the Cockpit mark) so Chrome on Android can add it to the home screen.

**How.** `App` takes the page mode from `/api/remote/me` and passes a phone flag to the sub-nav, list, card and thread view. The layout rules live in `styles/phone.css` under a 760px media query, with safe-area insets. Icons: `build/icon-maskable.svg` (full bleed, bars inside the safe zone) rendered by `scripts/render-icon.ts`; the macOS icon is reused for the plain sizes.

**Found on the way.** The first phone screenshot showed bubbles and the composer running off the right edge while the "fits the phone width" check passed. On a phone browser, content wider than the screen stretches the layout viewport itself, so `innerWidth` grew to 396 (and 829 without the phone styles) on a 360px screen, and "wider than the window" never triggered. The cause was the thread's implicit grid column sizing to its longest line; it now has a `minmax(0, 1fr)` column and a two-line title. The check compares with `screen.width` and measures every visible box. Control: with the phone styles removed, it fails.

**Gate.** `npm run proof:phone` 25/25 on the packaged app through real Tailscale, now including: every project's conversations labelled by project, no Files or Workflows tabs and no New button, the list and the conversation fitting the screen, the conversation opening full screen and Back returning, no agent switching or mark complete, and the manifest and all four icons served with the right type. Screenshots: `proof/phase-6-phone-list.png`, `phase-6-phone-thread.png`. Desktop proofs re-run on the same build: `proof:app` 10/10, `proof-b` b1 11/11, b2 12/12, b3 17/17, `proof:mcp` 16/16, `proof:reliability`, `proof:workflows` and `proof:files` all passed.


## Phase 6c–6d: notification implementation and real phone approval (2026-09-29)

Web Push signing keys and subscriptions live in the private Cockpit state directory. Each subscription belongs to a paired phone; removal revokes it. Approval requests trigger encrypted messages containing the project, title and conversation id. Notifications are sent only while phone access is running. Expired endpoints are removed after HTTP 404/410. The worker shows the notification and routes a tap to the conversation. The Mac panel can send a test notification.

The phone waits for an active worker and checks its browser subscription as well as the Mac record. Review found that a successful browser unsubscribe followed by a failed Mac cleanup restored the bell to on; this is fixed and tested, including reload with a stale Mac record. Permission is requested directly from the button before asynchronous registration work.

Validation: 138 tests, typecheck, web and Electron builds, packaging, and the packaged desktop reliability proof passed. `npm run proof:phone -- --live` passed 32 checks through real Tailscale, including a real Codex request to save a synthetic workflow. No workflow existed before approval; the phone opened the requested conversation from the notification URL, showed the approval, allowed it, and received completion without reload. Exactly one unscheduled workflow was saved. Screenshots: `proof/phase-6-phone-approval.png` and `proof/phase-6-phone-approved.png`. The first live run completed the operation but had an incorrect assertion expecting the workflow name inside Codex's approval card; the card identifies `save_workflow` and the activity line above holds the workflow name. The corrected assertion passed on the next run.

Limits: automated Chrome rejected actual push registration during the earlier session. The current automated phone gate checks worker registration and the bell, not physical-device delivery or a real notification tap. Real Pixel delivery is still a manual acceptance gate: enable the bell, send a test from the Mac, then confirm an approval notification opens its conversation. Claude's interrupted background regression wrapper returned zero despite individual app, MCP and Files proof failures. The app proof lost its window during a concurrent installation attempt; the other two failed during the Claude usage cap. Those Claude-dependent proofs were not retried in this continuation.

## MVP installation and documentation checkpoint (2026-09-29)

Implementation commit `44fb890` was pushed to `main`. The packaged app was installed only after verifying that the installed instance had no active conversations and the proof instances had closed. Its prior bundle was preserved in the private verification folder. Signature verification passed; the new installed process served the notification API and service worker, resumed phone access, and retained the existing pairing. Notification delivery remained disabled on that device at the installation check. No further runtime code changes were made for this documentation checkpoint.

PLAN now separates completed functionality, current verification and pending phone acceptance. ARCHITECTURE records the remote notification path and storage; README contains phone setup and the manual delivery check. Private handoff notes retain the command logs, installation result and previous app bundle.

## Setup for other users and review (2026-09-29)

The supported target remains macOS on Apple silicon. README now separates source-build prerequisites, agent sign-in, first conversation, optional phone access and per-user storage. The app ships no paired devices, credentials or project paths. Empty Model uses the user's CLI default; the account-specific Codex suggestion was removed. Development proofs retain an explicit model override through `COCKPIT_CODEX_MODEL`.

`npm run doctor` checks the platform and agent CLI versions with bounded local commands, and reports optional Tailscale installation separately. It performs no sign-in or agent work and does not claim authentication is valid. Tailscale discovery now searches the user's PATH before standard locations and rejects non-executable files/directories; the phone proof uses the same discovery. Two tests exercise custom install paths and fallback behavior.

Review found that Web Push lacked a network timeout, allowing a stalled endpoint to leave delivery and the test request pending. The sender now sets a 15-second socket timeout. Verification passed 140 tests, typecheck and both builds. Physical-phone push delivery and a full first run on a second person's Mac remain unverified; documentation does not present either as passed.

Scope clarification: this is an early MVP. The portability pass makes the existing Mac checkpoint easier for another builder to try; it does not expand the milestone into a finished cross-platform product. Remaining physical-phone checks are tracked openly and do not block MVP feedback.

The portability package passed 27 non-agent phone checks through Tailscale. Its application archive contains no per-user state files or CLI credential directories. Final focused review found no further blocking code findings after the unsubscribe and timeout fixes. The next session is reserved for a broader phases 1–5 walkthrough and selection of one release-critical flow; that inspection has not been marked complete.


## MVP inspection (2026-09-29)

**What.** A walkthrough of phases 1 to 5 on the packaged app, to record what works, what fails and the one flow the first release depends on. Claude hit its usage limit on the first live check, so every live check after that ran on Codex.

**Proof changes.** `proof:files` and `proof:mcp` take `--codex` (model from `COCKPIT_CODEX_MODEL`), through an `agent` option on the shared `chooseAgent` helper. Codex asks for cockpit tools as MCP approvals ("MCP: cockpit ... start_process"), so the process proof recognises that wording as well as Cockpit's own label, and keeps the full approval detail in its log. Claude with Haiku stays the default.

**Results.** 140 tests and builds; Codex conversation resume; desktop selection, routing, completion and reopening; file preview and an attachment-only answer; manual and scheduled workflows; 16 packaged process checks (approval, start, log, preview URL, served page, Stop, restart, nothing left running after quit). Fresh screenshots of Phase 4 and 5 use synthetic projects.

**Not covered.** The native folder picker, a real external browser opening the preview (the proof captures the request and fetches the URL), several live agents at once, Deny and session-wide approvals, stopping an active agent turn, setup on a second Mac, and push delivery to a physical phone.

**Polish noted.** Codex approval cards read technically ("MCP: cockpit"), and long titles are cut mid-word.

**Primary release flow.** Open a project, ask the agent to run its dev server and check the log, allow the start, get a working local preview URL, then stop or restart the server from the conversation. Files and workflows support it.

**Claude re-check.** After Claude's usage limit reset, the checks it had blocked were run on Claude with Haiku: the Claude to Codex switch with handoff (`proof-ui.ts switch`), `proof:files` including the attachment-only answer, and `proof:mcp` 16/16. All passed.

## Checkpoint 5a–5b: editing text and Markdown files (2026-09-30)

**What.** The Files panel became an editor: tabs, explicit save with a version check (a change made on disk meanwhile is a conflict, never overwritten: save mine as a copy, reload, or overwrite), and for Markdown a rich Document view beside Source.

**Spike first.** Before choosing an editor, 397 Markdown files from this machine were round-tripped through two candidates with no edits. Milkdown returned 12 byte-identical; the rest were restyled (table padding, `-` → `*`, `---` → `***`, escaped `~` and `[`). TipTap returned 6 and lost content (tables dropped, `&` → `&amp;`). Writing the whole document back from any rich editor would rewrite nearly every file, so TipTap was ruled out and the design became a splice.

**How.** `web/src/markdown/splice.ts` keeps each top-level block's original source text unless that block changed (matched by longest common subsequence); only edited or new blocks are serialised, in the marker style of the block they replace, and the spacing of the original neighbours is kept. `document.ts` then re-reads what would be written and refuses it unless it matches what is on screen. Re-run on the same corpus: all 397 files write back unchanged, and of 390 single-paragraph edits 379 were written with only that block changed and 11 were refused. None changed text outside the edited block.

**Found on the way.** Milkdown's view gives each heading an id that a plain parse leaves empty, so content comparison ignores it (caught only by the packaged-app proof; unit tests now run through a real view as well). A textarea normalises CRLF to LF and `TextDecoder` drops a byte-order mark; both are restored on save, and files mixing line endings are read-only. macOS inline predictions let Enter accept a guessed word; composer and editors turn writing suggestions off.

**Gates.** `npm run proof:edit` (18 checks) and `npm run proof:docs` (15 checks) on the packaged app, with synthetic files only.

## Checkpoint 6: context picker (2026-09-30)

**What.** One + in the composer for files and workflows, with chips for what the message will attach.

**How.** The draft text stays the single source of truth: chips are read from its `@file:`/`@workflow:` tokens (`web/src/draft-references.ts`) and edit it, so sending, storage and expansion are unchanged. Two Mac-only endpoints: `GET /api/files/search` (breadth-first walk, capped at 20,000 entries and depth 12, name matches ranked first) and `POST /api/references/check`, which resolves each distinct reference the way sending would.

**Found on the way.** Search results arrive after typing; Enter could pick a row left over from the previous query, so results now carry the query they answer. A chip checked once stayed green after its file was deleted; chips re-check every few seconds while the draft waits. A send error stayed on screen after the draft changed; editing clears it.

**Gate.** `npm run proof:context` (13 checks) on the packaged app, synthetic files, no agent runs.

## Phase 7: embedded preview and agent inspection (2026-10-01)

`open_preview` now opens the running local app beside Cockpit instead of sending it straight to the default browser. The pane is resizable and has reload, open-in-browser and close controls; clicking a live URL on the Processes page opens the same pane.

Agents with Cockpit MCP receive a new read-only `inspect_preview` tool. It loads only a loopback HTTP(S) URL in a short-lived sandboxed Chromium window with no Node access, captures the page, normalizes Retina output to 1280×800, and returns the PNG as image content. The visible frame is also confined to loopback navigation. Antigravity cannot receive this tool because its headless CLI still has no per-launch MCP configuration.

Gate: `npm run verify` passed 303 tests, typecheck and both builds. `npm run proof:preview` passed 8 checks on the packaged app: embedded rendering, local address, PNG inspection, resize, reload, close and reopen from Processes. Screenshot: `proof/phase-7-preview.png`.

## Phase 8 closure: subscription agents (2026-10-01)

The requested Google route is Antigravity, not standalone Gemini CLI. The Phase 7 package passed `proof:antigravity` 6/6 and `proof:opencode` 10/10. A real `smoke:antigravity` run used the cached Google/Antigravity subscription and preserved a codeword across two separate `agy` processes, proving conversation resume. OpenRouter models are configured through OpenCode; the adapter is packaged and proven against its protocol stand-in, while live OpenRouter billing/account access was not available and is not claimed.

This closes Phase 8 for the requested set: Claude Code, Codex, OpenCode and Antigravity. Grok Build remains a possible future adapter; it was not requested and no Grok CLI is installed on this Mac.

## Phase 9b recovery (2026-10-02)

Opening a project now discovers recent unfinished conversations, the latest user request and the current Git state. Resume imports or reuses a conversation, keeps native context for the same agent, applies safe defaults, and asks the agent to use the existing process/open/inspect tools. A provider change uses the existing transcript handoff. No sessions gives an honest project-exploration fallback.

Gates: 355 tests, typecheck, web/Electron builds, arm64 package, recovery (6), director (12), import (12), reliability and both live resume smokes pass. The recovery fixture exercises real packaged stdio MCP tools, one startup approval and a returned PNG; it does not establish live-model activation timing. Inline review and logs are in the private vault under `outputs/agent-cockpit/2026-10-02-phase9b-recovery/`. Public download replacement and a second-person acceptance remain separate work.

## Real recovery timing and alias correction (2026-10-02)

Added `proof:onboarding -- --live [--agent=claude] [--runs=3]`, requiring a durable `COCKPIT_ONBOARDING_OUT`. Three real-Claude runs reached an inspected preview and useful conclusion in 22.902, 20.901 and 19.886 seconds, each with one startup approval. The existing CLI was authenticated; project selection/approval were automated and the dependency-free project plus prior real session were prepared before timing. Second-person install remains unverified.

Fixed an actual import failure where Claude canonicalizes `/var` to `/private/var`, and supplied a fresh Git snapshot in recovery context to avoid a redundant shell approval. 356 tests and builds pass. The default Codex model requires a newer local CLI, so that timing path remains blocked; the explicit-model resume smoke passes. Raw evidence is beside the live-proof review in the private vault.
