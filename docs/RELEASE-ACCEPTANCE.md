# Release acceptance

## v0.1.7 candidate — 2026-10-10 (not published)

Everything merged since v0.1.6 (approval outcomes and countdown, visible permission level and send destination, Antigravity images, the Codex Stop/steer race fix, word-boundary titles), plus crash reports limited to what the beta terms name, Idle for a conversation with nothing running, and two lost-click fixes (Processes → Open site; the first click after typing in a document).

- Artifact: `Cockpit-0.1.7-arm64.dmg`, 128,443,058 bytes, arm64, ad-hoc signed, not notarized. SHA-256 `b4f46e4651602930f0f5e5b56beabbc2a2f0f635b9a13b0b13066b563a15144b`. Built from `e75149b` (a first build from `4ee183c` passed 105/105; its app bytes are identical, and the rebuild only added test-side checks to the gate).
- `npm run verify`: 1244 tests. CI green. `check:installers` and the landing checks passed.
- **Cumulative gate** (new, `scripts/gate.ts`): 36 deterministic packaged suites covering waves 1–12, CROSS-01–10, startup, recovery, window key, handoff, interruption, reports, session states, first run and find-and-inspect, three consecutive passes on one proof package (`app.asar` `8fadb911…`, unchanged throughout): 108/108, no process left behind. Its first run on main found nine proofs stale against UI merged since 10-08 and two product regressions, all fixed before this build.
- The DMG's app, copied to an isolated location: v0.1.7, signature ok, `app.asar` matches the packaged build (`29f9c8f7…`), release lockdown PASS.
- Startup (feature D11): six launches of the proof package showed the UI within 0.8 s, so no loading screen.
- Open: production-build manual flow, an independent person on their own Mac (the [tester checklist](user/tester-checklist.md)), two hours of real use, the live Chrome connected path, the full in-app second-account flow, physical-phone push, OpenCode's live OpenRouter path, and confirming the Sentry project's IP setting.

## v0.1.6 published prerelease — 2026-10-08

Waves 11 and 12 (the phone live preview on its own origin; account profiles per project and agent; worktrees with their lifecycle, merge back and two agents at once), the handoff preview before an agent switch, Report a bug / Send feedback, the one-line Terminal install, and crash and error reports through Sentry as a condition of the beta (`BETA-TERMS.md`, no off switch). First release that sends anything to the developer.

- Artifact: `Cockpit-0.1.6-arm64.dmg`, 128,416,765 bytes, arm64, ad-hoc signed, not notarized. SHA-256 `87da74b2cbd2ff4569aa1c0000308fe8d57efc4fc74fc5c1ad542bf5489bfd2e`.
- `npm run verify`: 1198 tests. `check:installers`: the three official installers match their pinned reviews. Landing render (390/768/1280) and local landing checks passed.
- Release-stage proofs on a proof build of the release commit: startup (7 scenarios), recovery (6), legacy recovery (6), window-key (21). `proof:startup` was updated in this release: it still expected the missing-CLI wording that D14 (`58c40a5`) replaced, and no gate runs it.
- The DMG's app, copied to an isolated location: reports v0.1.6, signature ok, `app.asar` matches the packaged build (`e84d408e…`), debug flags refused and window-only API (release lockdown PASS). Its main process is a release build (`IS_RELEASE_BUILD = true`) carrying the EU Sentry project.
- Gate: the 11 wave 12 gate proofs plus `proof:reports` and `proof:opencode`, three times each on one frozen package from main `26511d6` (the release commit adds the version, docs and the proof fix above): every case passed 3/3 except CROSS-02, 5/6 (one typed character missing from a new workflow's instructions; not reproduced in 100 targeted trials, at full and human speed, idle and under load). Evidence is kept in the maintainer's private release archive.
- Open: an independent person on their own Mac (the [tester checklist](user/tester-checklist.md)), physical-phone push, OpenCode's live OpenRouter path.

## v0.1.5 published prerelease — 2026-10-07

Everything since v0.1.4: parity waves 2–7 and 9, the wave 6.5 repairs, the audit and red-team fixes, the composer scanner and wave 10 (truthful CLI capabilities; install, update and sign-in from the picker through the official installers; updates that wait for idle). Each wave was accepted by its own packaged gate (three runs on one frozen package).

- Artifact: `Cockpit-0.1.5-arm64.dmg`, 128,147,537 bytes, arm64, ad-hoc signed, not notarized. SHA-256 `9deb00629074ff850a7bfc1facbb7e0040e7fe6013f33544f14f8257ebee31e6`. Tag `v0.1.5` at `a9ca62e`.
- `npm run verify`: 966 tests. `check:installers` matched the three pinned installers. Live, through Cockpit's own install code in an isolated home folder: Claude Code, Codex and Antigravity installed, Claude Code and Codex updated and signed in, a two-turn session with resume on each.
- The DMG's app, copied to an isolated location: v0.1.5, signature ok, `app.asar` matched the packaged build (`27957391…`), startup, recovery and window-only API proofs passed, debug flags refused.

## v0.1.4 published prerelease — 2026-10-03

Parity wave 1: reading and attention (stick-to-bottom with Jump to latest, copy message, ⌘F find, resizable list, calmer conversation bar, clips on sent messages, Mac notifications). First release built and published through `npm run release`.

- Artifact: `Cockpit-0.1.4-arm64.dmg`, 133,467,547 bytes, arm64, ad-hoc signed, not notarized. SHA-256 `4827994e7cf1a7d1b1fb10b199294fe4abcc7bcba27c918443deb8571d0638ee`. Tag `v0.1.4` at `fb47c33`.
- `npm run verify`: 422 tests. The DMG's app, copied to an isolated location, matched the packaged `app.asar` (`ae40bb0c…`), signature ok, and passed startup (missing/incompatible CLIs, no provider usage), recovery (6) and legacy recovery (6). Live update check: a 0.1.0 install was offered 0.1.4, the download resolved at the exact asset size, and 0.1.4 reported up to date.

## v0.1.3 published prerelease — 2026-10-03

Check for Updates (Cockpit menu): tells you when a newer Cockpit is published and opens the official download; installation stays manual.

- Artifact: `Cockpit-0.1.3-arm64.dmg`, 133,451,174 bytes, SHA-256 `835ff7fbdb0286f8d037fde491d7f79a43d6955b8cd67bff0dd3b4f9743d410a`.
- `npm run verify`: 391 tests. Installed-copy checks as above (`app.asar` `707f1b2b…` matched; startup, recovery 6, legacy recovery 6). `proof:updates` from 0.1.1 to 0.1.3 passed three times, including "offline is not worded as up to date".

## v0.1.2 published prerelease — 2026-10-03

Claude Code launch compatibility: Cockpit detects the installed Claude CLI's options and launches with the approval flag that version supports.

- Artifact: `Cockpit-0.1.2-arm64.dmg`, 133,450,176 bytes, SHA-256 `8d2cb3cbe96e67a1b83e6834639714db67a84ad01a7a165668de56c70c264fd2`.
- `npm run verify`: 367 tests. Installed-copy startup, recovery (6) and legacy recovery (6) passed. Same-Mac acceptance on a second account with Claude Code 2.1.220.

For v0.1.2–v0.1.4 the evidence (logs, install verification, hosted landing checks) is kept in the maintainer's private release archive, as for v0.1.1. Still open for all of them: an independent person on their own Mac (the [tester checklist](user/tester-checklist.md)) and physical-phone push.

## v0.1.1 published tester build — 2026-10-02

This prerelease includes Phase 9a setup, 9b recent-work recovery, MCP conversation controls and tester hardening. The historical Day 30 checklist below remains evidence for v0.1.0; it is not a claim that every historical gate was repeated for v0.1.1.

- Artifact: `release/Cockpit-0.1.1-arm64.dmg`, 133,455,985 bytes, arm64, ad-hoc signed and not notarized.
- SHA-256: `b34ad184bf0144502624e557c8d5a8cdd9acad2bbc41c12d051f8e83ad9dbede`.
- Source: runtime through `f827a1c`, with the release version changed to 0.1.1. `npm run verify`: 356 tests, typecheck, web and Electron builds passed before packaging.
- Mounted the final DMG read-only, copied its app into an isolated Applications folder, detached it, checked version/signature and matched the application archive to the packaged app. That copied app passed recovery (6 checks), director (12), missing-CLI startup/retry (5 scenarios), and MCP controls (Claude fixture, 8). No provider usage in these fixtures.
- The same recovery implementation previously passed import (12), reliability, real Claude/Codex resume smokes and three real-Claude activation runs: 22.902s, 20.901s, 19.918s. Each used fresh Cockpit state, an already signed-in CLI, a generated dependency-free project and a real prior session prepared outside timing. Each required one startup approval and produced an inspected interactive preview.
- Evidence: kept in the maintainer's private release archive (not in this repository), including `install-verification.json`, final installed proofs, timing transcripts/screenshots and release checks.
- Open: a group member on their own Mac must complete the [tester checklist](user/tester-checklist.md). This installation copy test does not establish independent Gatekeeper/setup acceptance or human onboarding time. The local Codex 0.147.0 default-model trial was blocked by a newer-model CLI requirement; the explicit-model resume smoke passed. Live OpenRouter and physical-phone push remain unverified.

Published from tag `v0.1.1` at `d2c7416` via [release PR #2](https://github.com/Holodeck23/agent-cockpit/pull/2). An unauthenticated full download returned HTTP 200, 133,455,985 bytes and the exact SHA-256 above. The production [Vercel page](https://agent-cockpit-theta.vercel.app) returned HTTP 200 and byte-for-byte matched the reviewed landing source; its v0.1.1 download link, recovery screenshot and approval simulation passed a hosted browser check. The source branch and Jules’s documentation-only PR #1 are merged.

## Historical Day 30 boundary (v0.1.0)

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
- Automatic usage-limit failover or automatic agent selection.
- Treating **Deny** or **Allow for this session** as release-critical acceptance paths.
- Simultaneous multi-agent stress acceptance.
- A second-Mac onboarding pass, notarization and automatic installation.
- Windows, Linux and Intel Mac support.
- Live OpenRouter account validation and a Grok Build adapter; Phase 8's requested OpenCode and Antigravity routes are implemented.
- Production accounts, billing, a public relay or cloud-hosted conversation storage.

Phase 7 landed after this Day 30 boundary was accepted. `open_preview` now targets the embedded pane, with **Browser ↗** retaining the external-browser option; `inspect_preview` gives compatible agents a loopback-only PNG. Its separate packaged gate is `proof:preview` (8/8, 2026-10-01).

## Release decision

The boundary-setting task is complete when this file remains the canonical checklist. The release itself is accepted only when all P0 boxes are checked with evidence from one packaged build and the commit/package identifier is recorded below.

- Accepted commit: `f38a437`
- Accepted package: `release/mac-arm64/Cockpit.app` built from `f38a437` (ad-hoc signed, arm64), used for `proof:limit` and the walkthrough
- Acceptance date: 2026-09-30
- Quit cleanup re-observed: after quitting the walkthrough app, no Cockpit, agent, MCP or dev-server process remained.

## Published download check (v0.1.0)

2026-09-30, on the DMG as published on the GitHub pre-release (sha256 `f357ce37…0300f4`, built from `7f71827`), not the local build:

- Marked as a browser download, both the DMG and the installed app are rejected by `spctl`, as the README says. After the README's `xattr -dr com.apple.quarantine`, the app launches.
- Installed to a fresh folder outside `/Applications`, with empty thread storage and launchd's bare PATH. The proofs point at it via `COCKPIT_APP=<path>/Cockpit.app`.
- `proof:app` 10/10 (found `claude` through the login-shell PATH, Haiku reply, quit mid-turn left nothing running), `proof:mcp` 16/16 with Claude and 16/16 with `--codex`, `proof-b.ts b3` 20/20. No process left behind afterwards.
- Not covered: a separate macOS account with its own CLI logins and no existing `~/.claude` or `~/.codex`, and clicking Open Anyway in System Settings. That second-account run is still open.

## Known issues found during acceptance

- ~~**Starter click-through (P1)**~~ *Fixed 2026-09-30:* the native folder picker's Open button sat over the first-run starter suggestions, which sent on one click. Starters now only fill the message box and focus it; Enter sends. The composer also turns off macOS inline writing suggestions, whose guessed word Enter would otherwise accept instead of sending. Gate: `tsx scripts/proof-b.ts b3` (20 checks) on the packaged app.
