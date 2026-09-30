# Agent Cockpit: a real Mac app with an Enjoy-clone UI

**Status 2026-09-29:** The desktop MVP and phone approval flow are installed and running. Implementation checkpoint `44fb890` is on `main` and was pushed to the remote.

- **Complete:** Claude/Codex adapters, conversations and approvals, desktop UI, process tools, workflows, file attachments, Tailscale pairing, phone layout, and the real Codex phone-approval gate.
- **Implemented, awaiting device acceptance:** encrypted Web Push, subscription recovery, and notification-to-conversation routing. Actual delivery and tapping on a physical phone remain unverified.
- **Verified for this checkpoint:** 140 tests, typecheck, both builds, packaging, 32 phone checks through real Tailscale, and packaged desktop reliability. Earlier Claude-dependent proofs were not repeated during its usage cap; see BUILD-NOTES for their last failures.
- **Installed:** the packaged app was signature-checked and launched. Phone access and the existing pairing resumed; the previous app bundle was preserved privately.
- **Portable setup:** each person uses their own CLI accounts, project folder and Tailscale account; `npm run doctor` checks prerequisites. Model selection defaults to their CLI configuration.
- **Next:** walk the primary release flow on a fresh setup (below), complete physical-phone notification acceptance, then Phase 7 preview pane. Additional agent adapters remain Phase 8.


## MVP inspection (2026-09-29)

Fresh walkthrough used the packaged app and Codex `gpt-5.6-luna`. Claude's first live check hit its provider cap; no further Claude calls were made.

- **Works:** 140 tests and builds; Codex conversation resume; desktop selection/routing/completion; files and attachment answers; manual/scheduled workflows; 16 packaged process checks covering approval, start, logs, preview routing, Stop, restart and quit cleanup.
- **Claude, after its limit reset:** the Claude↔Codex handoff, the attachment answer and the 16 packaged process checks all pass.
- **Still unverified in this inspection:** native folder picker, actual external-browser opening (the proof captures the request and fetches the URL), simultaneous live agents, Deny/session-wide approvals, active-agent Stop, second-Mac setup and physical-phone push.
- **Polish observed:** technical Codex MCP approval wording and conversation titles truncated mid-word.
- **Screenshots:** refreshed Phase 4 and Phase 5 captures in `docs/proof/`, using synthetic projects. Run logs and the full checklist are kept outside the repo.

**Primary release flow:** open a project → ask Codex to run its dev server and inspect the log → allow the action → receive a working local preview URL → stop or restart the server from the conversation.

**Next acceptance:** walk that flow from the native folder picker through an actual browser opening on a fresh setup. Files and workflows support this flow. Keep physical-phone push visibly pending; preview-pane development remains Phase 7.

## Day 30 release boundary

The prioritized, testable ship gate and explicit exclusions are maintained in [RELEASE-ACCEPTANCE.md](RELEASE-ACCEPTANCE.md). P0 is the desktop project → approval → dev server → log → external preview → Stop/restart loop, plus visible provider-limit handling and manual agent switching. Optional phone, workflow, file and future-agent work cannot delay the release unless it regresses that core flow, data safety, approval safety or process cleanup.

## Upgrade sequence after the Enjoy trial (agreed 2026-09-30)

A signed-in Enjoy trial was compared against this source at `b8bc616`. The trial evidence contains account details and is kept privately outside the repo. The agreed order, one independently usable checkpoint at a time:

0. **Release baseline.** *(Done 2026-09-30: every P0 item accepted on the `f38a437` package.)* Close the unchecked P0 items in [RELEASE-ACCEPTANCE.md](RELEASE-ACCEPTANCE.md) on one identified packaged build before any feature work.
1. **Activity pane.** *(Done 2026-09-30: `npm run proof:activity`, 18 checks including one live Codex run.)* An optional, resizable pane beside the conversation, built from stored tool events (name, state, expandable input/output, timing). Answers and approvals stay in the conversation. Interrupted or unmatched tool calls are shown as such.
2. **Agent availability and usage.** *(Done 2026-09-30: `npm run proof:agents`, 10 checks; `proof:limit` re-run 9/9.)* Installed/problem state and the latest provider-reported usage and reset time in the agent picker, with the time it was observed. Unknown stays distinct from available; no quota bars from guessed strings, no polling or automatic failover.
3. **Project instructions.** *(Done 2026-09-30: `npm run proof:instructions`, 6 checks with real Claude and Codex turns.)* Bounded optional instructions per project, delivered once through Claude's appended prompt and Codex's developer instructions. They take effect at the next launch/resume/switch and are recorded with the session. They never change permissions or overwrite repository instruction files.
4. **Workflow discovery.** *(Done 2026-09-30: `npm run proof:discovery`, 11 checks; `proof:workflows` re-run green.)* Search, collections and All/Scheduled/Manual views; an editable title separate from the stable `@workflow:` slug; five original starters (project orientation, focused review, release check, handoff note, dev-server startup). Copying a starter never schedules or runs it.

Checkpoints 1–4 ship together as the first upgrade. **First upgrade complete 2026-09-30.** Later, each its own checkpoint: 5a editable text files, 5b rich Markdown documents, 6 composer context picker, 7 calendar schedules (daily/weekday/weekly, local time, explicit DST and missed-run rules).

Follow-ups from a second Enjoy evidence pass (2026-09-30), each proven on the packaged app:

- **Starter click-through fixed.** Starters fill the message box instead of sending; the composer turns off macOS inline writing suggestions, whose guess Enter accepted instead of sending. (`tsx scripts/proof-b.ts b3`, 20 checks.)
- **A finished turn reads Ready**, without a check mark; the check is only for marking a conversation complete. Messages that use `@workflow:` keep each referenced workflow's instructions as they were. A thread records the project instructions text its session received. The new-conversation agent choice is remembered per project. (`proof:workflows`, `proof:instructions` 8 checks, `proof:activity` 18, `proof:app` 10.)
- **5a editable text files — done.** *(`npm run proof:edit`, 16 checks; `proof:files` re-run green.)* Tabs, dirty marker, explicit Save and Cmd+S, Revert. Every save names the version it started from; a change made on disk meanwhile (by the agent or another editor) shows a conflict with Reload from disk / Overwrite with mine, never a silent overwrite. Saves are atomic and keep the file mode; line endings and a byte-order mark are kept, and files that mix line endings stay read-only. Drafts and open tabs persist per project, and closing an unsaved tab asks first. New files go in an existing folder and never replace one. Editing is Mac-only; the phone cannot write files. Autosave is deliberately out: agents write the same files, so saving stays a decision.

**Proposed, not adopted:** let desktop P0 completion gate Phase 7 and track physical-phone push as a separate acceptance item. Phase 7 below keeps its current gate until this is decided.

## Scope for the first release

This is an early build. Prioritize a usable demo, clear setup for other builders and feedback from trying it. Ship small verified checkpoints and keep incomplete features visible. Cross-platform packaging, broad onboarding automation and production polish can wait. Physical-phone push acceptance is pending, but it does not block trying the desktop and phone-approval MVP.

## Original scope (historical)
Phases 0–3 are built and proven in this repo (4 commits): the Claude adapter, the Codex app-server adapter, threads + SSE, approvals, Stop, the Claude↔Codex switch with handoff, and 30 unit tests. Today it runs as a local server you open in a browser. Two changes:
1. **A real desktop app**, not localhost in a browser.
2. **A UI that looks like Enjoy.** Reference screenshots and measured design tokens were captured privately (not in this repo). The useful ones were `section-coach-tour.png`, `demo-07-send.png`, `demo-08-open-plant.png`, `tour2-15-dark.png`, `section-home-features.png` and a measured `design-tokens.txt`.

**Clone boundary:** copy the layout, interaction model and visual language. Don't copy Enjoy's name, logo, mascot or illustrations; those are its brand. The app is called **Cockpit** with its own three-bar mark, and every illustration is our own simple SVG. No code or assets are lifted from their site. The CSS is written fresh from the measured tokens.

## Decision: Electron shell around the existing server
- **Tauri** (Enjoy's choice, Rust installed) would need a bundled Node sidecar (~100MB, which cancels the size win) or a Rust rewrite of the proven backend.
- **Electrobun** is too young to add runtime risk.
- **Electron** runs `server/*` unchanged in its main process. `titleBarStyle: 'hiddenInset'` puts the traffic lights inside our project tab bar, exactly like Enjoy.
- The loopback HTTP/SSE server stays inside the app. The renderer talks to it on a random 127.0.0.1 port, guarded by the existing Host/Origin check. It's also what Phase 6 (phone access) builds on.

## Phase A: desktop shell (checkpoint 1)
- Refactor `server/index.ts` into `server/start.ts` → `startServer({ port, host, webDist }): Promise<{ url, close }>`. `server/index.ts` becomes a thin CLI wrapper, so `npm start` and the smokes keep working.
- `electron/main.ts`:
  - single-instance lock;
  - `startServer({ port: 0 })`, then a `BrowserWindow` (1360×860, min 980×640, `titleBarStyle: 'hiddenInset'`, `trafficLightPosition` aligned to the tab bar, background matched to the canvas colour so there's no white flash);
  - load the server URL;
  - macOS menu (About, Hide, Quit, Edit roles for copy/paste, View reload/devtools in dev);
  - graceful shutdown that closes agent sessions (`manager.shutdown()`).
- `electron/preload.ts` → `contextBridge` exposes `cockpit.pickFolder()` (native `dialog.showOpenDialog`) and `cockpit.platform`. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- PATH fix: a GUI-launched app doesn't inherit the shell PATH, so `claude` and `codex` wouldn't be found. At startup, resolve the login-shell PATH once (`$SHELL -ilc 'echo $PATH'`) and merge it into `process.env.PATH`.
- Build: esbuild bundles `electron/main.ts` + `server/**` into `dist-electron/`, and Vite builds `dist/`. `electron-builder` produces `release/mac-arm64/Cockpit.app` and a `.dmg`. The build is unsigned and ad-hoc signed for personal use. Scripts: `npm run app` (dev: Vite + Electron), `npm run package`.
- Icon: our own 3-bar mark (SVG → `.icns` via `iconutil`).
- **Gate:** launch the packaged `Cockpit.app` through Playwright's `_electron` API, start a Haiku thread from the window, see it reach Done, and screenshot to `docs/proof/phase-A-app.png`. The app also has to find `claude` when launched from Finder with no terminal PATH; this is checked in the proof by launching with a minimal env.

## Phase B: Enjoy-clone UI (checkpoints 2–4, one commit each)
Tokens (`web/src/styles/tokens.css`, `light-dark()` pairs, dark by `prefers-color-scheme` plus a manual toggle):
- canvas `#fffdf9`/`#191a1d`, surface `#fff`/`#25262b`, ink `#242422`/`#f2f0eb`, muted `#72736d`
- chrome `#e5e5df`, subnav-active `#f0f0eb`
- blue `#2878ef`, pressed-shadow `#1d56ac`, halo `#2459e824`
- pink `#b53270`, orange `#f58220`
- system font 14px; display `ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold"`
- radii 7/8/12/14/16; buttons have a 3px bottom "pressed" shadow

**B1 Chrome (checkpoint 2):** `ProjectTabBar`
- traffic-light gap
- our mark
- pinned project tabs: letter avatar in the project colour, name, working-count badge with the 3-bar icon, needs-you badge with a count
- "Projects ▾" menu on the right: open a folder via `pickFolder`, list recent projects

`SubNav`: Conversations · Files · Workflows segmented tabs, plus the right-side icon buttons. Files and Workflows are placeholders until Phase 5.

New server bit: a `projects.json` store (`server/projects/store.ts`) with path, name, colour and pinned flag. Projects are auto-registered from threads.

**B2 Conversation list (checkpoint 3):**
- "Conversations" heading in the rounded display font, an illustration (ours) and the blue 3D + button
- search field that filters by title and preview
- filter tabs with live counts: All · Needs you · Working · Unread. "Unread" means updated since you last opened the thread, tracked client-side.
- conversation cards: coloured tag chip (first 2–3 words of the title, or a set tag), title, "Claude Code · Today", status pill with the 3-bar icon while working
- footer: "N conversations" and a "Show completed" checkbox

**B3 Thread + composer (checkpoint 4):**
- **Header:** large title, a status line (coloured "Working" plus the transcript path, which opens in Finder), segmented Stop/Complete buttons, and a ⋯ menu that holds the agent switcher.
- **Messages:** an author row (our icon, "You" / "Claude Code" / "Codex", time) above a rounded surface card. Tool calls collapse into activity lines like "Building the plant list · 0:03" with a live timer from the step's start. Approval requests become inline cards with Allow / Allow for session / Deny.
- **Empty state:** illustration, "What are you working on?" with a subtitle, and three suggestion cards with an ↑ button.
- **Composer:** white card with a 14px radius and a blue focus halo; placeholder "Describe what you want…" or "Add a follow-up…"; an "@ Files and workflows" chip (inert until Phase 5); a bottom row with +, the agent picker (agent icon, name, model · effort, ▾) and the blue send button.

**Gate for each B checkpoint:** in the packaged app, screenshot the same states as the reference (empty state, working thread, needs-you approval, dark mode) into `docs/proof/phase-B*-*.png` and compare them against the reference images. Layout, colours and type have to match on sight. Existing unit tests and proofs stay green (proof selectors get updated where markup changes).

## Phase 4: cockpit MCP (done 2026-09-29)
Scope as agreed: there was no process runner, preview pane or workflow store yet, so Phase 4 built the runner and `open_preview` opens the default browser; `save_workflow` moved to Phase 5.
- **4a Process runner** (`server/processes/`): per-project long-running commands, each in its own process group; ring-buffered (512 KB), ANSI-stripped, numbered output; first local URL detected. Stop = group SIGTERM → SIGKILL after 3s; all stopped on quit. `/api/processes` + a named `process` SSE event.
- **4b MCP** (`server/mcp/`): stdio server bundled to `dist-electron/mcp.cjs`, run by the app binary with `ELECTRON_RUN_AS_NODE=1`. Tools: `start_process`, `stop_process`, `list_processes`, `read_process_output`, `open_preview` (loopback URLs only). Per-session bearer token (identity + project scope, not secrecy: the loopback API is open to local processes anyway) in the agent's env, never argv; Claude's MCP servers inherit it, Codex forwards it via `env_vars`. Read-only tools pre-allowed; start/stop use the approval card (Codex's arrive as MCP elicitations). One guidance line in the system prompt.
- **4c UI + gate:** a process chip in the thread status line (`1 process · :5173`) opening a list with URL and Stop; cockpit tool calls read as plain activity lines. Gate `npm run proof:mcp`: real Haiku, prompt names no tools; it started, read the log, opened the preview, and quit left nothing running. Codex covered by `npm run smoke:mcp codex`.

## Phase 5: workflows and project files (done 2026-09-29)

- **5a Workflows:** project-scoped saved instructions, manual runs, bounded `@workflow:name` expansion, approval-gated `save_workflow`, and schedules that run while Cockpit is open.
- **5b Workflow UI:** create, edit, run, schedule, pause and archive workflows with per-run agent settings. Manual and scheduled Codex runs passed in the packaged app.
- **5c Files:** bounded project browsing, text preview and `@file:` attachments for new or existing conversations. Stored messages retain references rather than copying file contents into titles and transcripts.

## Phase 6: phone access and approvals (implemented 2026-09-29)

- **6a Tailscale access:** an isolated phone listener, owner allowlist, six-digit pairing, revocable device tokens and guarded phone routes.
- **6b Phone UI:** one-column conversation list and thread view, replies, approval actions and Stop, plus an installable Android home-screen app.
- **6c–6d Notifications and live approval:** encrypted Web Push subscriptions, approval notifications, notification-to-conversation routing, and a real Codex workflow approval completed from the paired phone view.
- **Gate:** 32 packaged phone checks passed through real Tailscale. The remaining manual acceptance item is actual notification delivery and tap routing on a physical phone; implementation and browser-side routing are complete.

## Phase 7: embedded preview pane (not started)

Retarget `open_preview` from the external browser to an in-app preview pane, then let the agent inspect its own UI change with a screenshot. Start only after the physical-phone notification acceptance check.

## Phase 8: more agents (requested 2026-09-29, not scheduled)

Enjoy drives five CLIs: Claude Code, Codex, Grok Build, OpenCode and Antigravity. Add the remaining three as adapters behind the same `NormalizedEvent` model, one per checkpoint, each with a smoke and a parser test against recorded traffic.
- **Antigravity:** `agy` with stream-json output and `--conversation` for resume. Its Google sign-in is a terminal prompt, so first-run login needs its own flow.
- **OpenCode:** `opencode acp --hostname 127.0.0.1 --port 0` (Agent Client Protocol), config passed through the environment.
- **OpenRouter:** an API, not an agent CLI. The likely route is OpenCode, which supports OpenRouter as a model provider, so OpenRouter models arrive with the OpenCode adapter and no separate agent loop. Verify against current OpenCode docs before building.
- **Grok Build:** in Enjoy's list; not requested yet.
- Open questions: approvals and MCP injection per CLI, and what the agent-switch handoff needs for agents without a resumable session.

## Verification
- Every checkpoint: `npm run verify` (typecheck + unit/integration tests + builds) and the `npm run smoke:claude` / `smoke:codex` smokes.
- A packaged-app proof via Playwright `_electron`, with screenshots in `docs/proof/`.
- One commit per checkpoint, pushed to github.com/Holodeck23/agent-cockpit (public since 2026-09-29; history scrubbed of personal paths before the first push).
- Final: `release/mac-arm64/Cockpit.app` exists and launches from Finder. Installing is one copy to /Applications.
