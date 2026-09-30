# Day 30 release acceptance

The release is a macOS Apple-silicon early build for one reliable job:

> Open a project, ask an installed agent to start its dev server and inspect the log, approve the start, open the working preview, then stop or restart the server from the conversation.

Ship only when every **P0** item passes on the same packaged build. A checked item has current automated or packaged-app evidence. An unchecked item is a release blocker until it is exercised and recorded.

## P0 — release blockers

### Baseline and first run

- [x] `npm run verify` passes typecheck, unit/integration tests, the web build and the Electron build. Latest inspection: 140 tests passed.
- [x] The packaged-app reliability proof passes with isolated state; the packaged app proof launches with a Finder-like PATH and leaves no agent process behind.
- [x] Starting with a fresh `COCKPIT_HOME`, the packaged app opens from Finder, the native folder picker selects a synthetic project, and one installed agent can start a conversation without a terminal-provided PATH. Walkthrough 2026-09-30: launched through LaunchServices (`open -n -a … --env COCKPIT_HOME=<empty>`, the same launchd environment as Finder); the native picker registered the synthetic project; Claude and Codex conversations both started and ran tools.

### Approvals — in scope

- [x] `start_process` cannot run before the user approves it; the packaged MCP proof sees and answers the approval card.
- [x] `list_processes`, `read_process_output` and `open_preview` remain read-only and do not ask for approval.
- [x] Answered, expired and previous-session approval IDs cannot be replayed.
- [x] In the fresh-package walkthrough, choosing **Allow** starts exactly one dev server and the conversation continues without a duplicate approval or process. Walkthrough 2026-09-30 (Codex gpt-5.6-luna): one `start_process` approval, allowed by a person clicking the card; exactly one `npm run dev` / `node server.js` under the app; the turn continued to log check, preview and Done.

Only the **Allow** path for the release-critical process start is P0. **Deny**, **Allow for this session**, arbitrary shell/file approvals and phone-originated approvals are implemented but are not Day 30 release gates.

### Usage-limit handling — in scope, narrowly

- [x] Recorded Claude and Codex protocol fixtures normalize five-hour usage events, including reset information where the provider supplies it.
- [x] A packaged UI check proves the conversation menu renders the latest provider-reported five-hour status and reset time. `npm run proof:limit` (2026-09-30): "Limit reached, resets 5:12 PM" from the rejected event, then "23% used, resets 7:35 PM" after the next Codex turn.
- [x] A packaged acceptance fixture or controlled live case proves that a rejected limit/error ends visibly instead of leaving the conversation Working, and that the user can switch the stopped/failed conversation to the other installed agent and continue from its transcript. `npm run proof:limit` (2026-09-30, 9/9): a recorded limit stand-in for Claude (`scripts/fixtures/limit-agent`, found through `COCKPIT_AGENT_PATH`) ends as Error with the limit message; a manual switch to real Codex recalls a codeword only Claude was told. Screenshots `docs/proof/p0-limit-*.png`.

Automatic agent switching, background quota polling, predicting exhaustion and bypassing provider limits are deferred. The release promises visible provider-reported state and a manual switch only.

### Dev-server controls — in scope

- [x] The agent starts the server through Cockpit, receives its startup output and detects a loopback preview URL.
- [x] The agent checks the server log and the served page responds with the expected content.
- [x] `open_preview` opens that URL in a real external browser during the fresh-package walkthrough; intercepting the request or fetching the URL in the proof is insufficient. Walkthrough 2026-09-30: 0.26 s after `open_preview`, the dev server logged `GET /` then `GET /favicon.ico` from a desktop Chrome user agent, i.e. a real browser tab.
- [x] Starting the same named server again reuses the running process rather than silently creating a duplicate.
- [x] **Stop** terminates the whole process group and closes the port.
- [x] A follow-up can restart the server and expose a working URL again.
- [x] Quitting Cockpit terminates every agent and dev-server process it started.

## P1 — must not regress P0, but does not block release

- Files and `@file:` attachments.
- Saved workflows, manual runs and schedules.
- Tailscale phone access, pairing, phone replies, approvals and Stop.
- Conversation search, filters, dark mode and completion/reopening.
- Multiple simultaneous conversations.

These features may remain in the build, but unfinished polish or optional acceptance does not delay Day 30 unless it breaks a P0 flow, loses user data, bypasses approval, or leaves processes running.

## Explicitly deferred or excluded

- Physical-phone Web Push delivery and notification-tap acceptance.
- The embedded preview pane and agent screenshot inspection (Phase 7); the external browser is the release behavior.
- Automatic usage-limit failover or automatic agent selection.
- Treating **Deny** or **Allow for this session** as release-critical acceptance paths.
- Simultaneous multi-agent stress acceptance.
- A second-Mac onboarding pass, notarization and automatic installation.
- Windows, Linux and Intel Mac support.
- Antigravity, OpenCode, OpenRouter and Grok Build adapters (Phase 8).
- Production accounts, billing, a public relay or cloud-hosted conversation storage.

## Release decision

The boundary-setting task is complete when this file remains the canonical checklist. The release itself is accepted only when all P0 boxes are checked with evidence from one packaged build and the commit/package identifier is recorded below.

- Accepted commit: `f38a437`
- Accepted package: `release/mac-arm64/Cockpit.app` built from `f38a437` (ad-hoc signed, arm64), used for `proof:limit` and the walkthrough
- Acceptance date: 2026-09-30
- Quit cleanup re-observed: after quitting the walkthrough app, no Cockpit, agent, MCP or dev-server process remained.

## Known issues found during acceptance

- ~~**Starter click-through (P1)**~~ *Fixed 2026-09-30:* the native folder picker's Open button sat over the first-run starter suggestions, which sent on one click. Starters now only fill the message box and focus it; Enter sends. The composer also turns off macOS inline writing suggestions, whose guessed word Enter would otherwise accept instead of sending. Gate: `tsx scripts/proof-b.ts b3` (20 checks) on the packaged app.
