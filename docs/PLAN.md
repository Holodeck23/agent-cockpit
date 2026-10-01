# Agent Cockpit: a real Mac app with an Enjoy-clone UI

**Status 2026-09-30:** `v0.1.0` is published as a GitHub **pre-release** with `Cockpit-0.1.0-arm64.dmg` (built from `dd8aab1`, ad-hoc signed, arm64) for a small group of testers. Every P0 item in [RELEASE-ACCEPTANCE.md](RELEASE-ACCEPTANCE.md) is accepted; checkpoints 5a, 5b and 6 landed after acceptance with their gates green.

- **Distribution:** not notarized (no Apple Developer account, decided 2026-09-30). On macOS 26, Gatekeeper rejects the app (`spctl`: rejected; DMG: no usable signature) and the first launch shows "Cockpit" Not Opened with only Move to Trash / Done; right-click → Open no longer bypasses it. The README and release notes give the steps that work: Privacy & Security → Open Anyway, or `xattr -dr com.apple.quarantine /Applications/Cockpit.app` (verified on a quarantined copy).
- **Since acceptance:** a missing CLI now says "Claude Code isn't installed or isn't on PATH…" instead of the raw spawn error; rtl-clipped paths in the conversation and Projects menus keep their leading slash (checked in `proof:reliability`); `proof-b b1` and `proof:limit` updated to the current menus.
- **Verified 2026-09-30:** `npm run verify` (216 tests), `proof:app` 10, `proof:reliability`, `proof-b b1` 11, `proof:limit` 9, all on the packaged app.
- **Next:** stranger install on a second macOS user (see RELEASE-ACCEPTANCE), physical-phone push acceptance, then Phase 7 preview pane. Calendar schedules (checkpoint 7) and more agent adapters (Phase 8) are after the first release.


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
- **5a editable text files — done.** *(`npm run proof:edit`, 18 checks; `proof:files` re-run green.)* Tabs, dirty marker, explicit Save and Cmd+S, Revert. Every save names the version it started from; a change made on disk meanwhile (by the agent or another editor) shows a conflict with Save mine as a copy / Reload from disk / Overwrite with mine, never a silent overwrite. Saves are atomic and keep the file mode; line endings and a byte-order mark are kept, and files that mix line endings stay read-only. Drafts and open tabs persist per project, and closing an unsaved tab asks first. New files go in an existing folder and never replace one. Editing is Mac-only; the phone cannot write files. Autosave is deliberately out: agents write the same files, so saving stays a decision.
- **5b Markdown documents — done.** *(`npm run proof:docs`, 15 checks; every save is compared byte for byte with the expected file.)* Markdown files open in a Document view (Milkdown, loaded on demand) with a Source switch, a small formatting toolbar and clickable to-do boxes. Blocks you did not edit keep their exact original text; edited blocks are rewritten in their own style (bullet, rule and fence markers), and a change that would not read back as shown is refused rather than written. Front matter is kept verbatim. Both views edit the same draft, so save, conflicts, copies and draft recovery work unchanged; Cmd+S flushes the latest edit first.
- **6 Context picker — done.** *(`npm run proof:context`, 13 checks; `proof:files`, `proof:workflows`, `proof-b b3` re-run green.)* The composer's + searches the project's files (bounded walk, dependencies and links skipped, 30 results) and its workflows, and adds them as the same `@file:`/`@workflow:` references as before. What a message will attach shows as removable chips; duplicates are marked, and a reference that would fail if sent now (missing file, unknown workflow) turns red before sending and is re-checked while the draft waits. The 8-file limit is shared with the server. Mac only, like the Files panel.

## Second upgrade (agreed 2026-10-01)

Source: one recorded Enjoy walkthrough analysed separately by Gemini and by Antigravity (a frame-by-frame specification), checked against the private 2026-09-30 trial evidence and this source. An item is listed only if both analyses agree or the trial evidence shows it; order is daily-use value first, account and paid features last (U11). Antigravity's suggested build plan (Tauri, SQLite, direct model API calls) is not adopted: Cockpit drives the installed agent CLIs on the user's own subscriptions, and its Electron shell and stores stay.

Cockpit may become a paid product later. Paid features come last and start as clearly labelled placeholders: no payment code, no prices, nothing that looks like a working purchase.

Each checkpoint is its own commit with a packaged-app proof, pushed when green.

- **U1 Git branch control.** *(Done 2026-10-01: `npm run proof:git`, 19 checks on the packaged app, no agent usage.)* A branch pill in the composer shows the project's current branch; hidden when the folder is not a Git repository. Its popover searches local branches, switches, creates and switches, and pushes the current branch. It says it applies to every conversation in the project. Switching or creating is refused while any conversation in the project is working or waiting on an approval. Switching is also refused with uncommitted changes (it counts and names them; no automatic stash); creating a branch keeps them, as Git does, so nothing is lost. A folder outside any repository never starts git. Push uses the user's own Git setup and shows Git's error text when it fails. Gate `proof:git`: a scratch repository with a local bare remote; switch, create, push reaches the remote, blocked while a turn runs, dirty tree refused, non-repository hides the pill.
- **U2 Processes page.** *(Done 2026-10-01: `npm run proof:processes`, 15 checks on the packaged app with a stand-in agent that starts the server through the cockpit MCP API.)* A Processes view listing every process the cockpit runner started in the project (search, count, state, port) with a live log beside it and Stop/Restart, opened from an icon in the top bar. Its empty state explains that processes appear when an agent starts a site or server. Reuses the existing runner; the header chip stays. Gate `proof:processes`.
- **U3 Conversation menu and decisions.** *(Done 2026-10-01: `npm run proof:thread-menu`, 16 checks on the packaged app with a stand-in agent that asks for approvals in Claude Code's format; `proof-b b3` updated and green.)* Mark as unread, and Delete conversation: stops its agent session first, confirms inside the app, removes the stored conversation. Answered approvals collapse into a short decision line ("1 decision · Allowed"; answers with nothing between them share one, "2 decisions · 1 allowed, 1 denied") that expands to the answer, tool and command. A completed conversation ends with a Reopen button below the last message. Gate `proof:thread-menu`.
- **U4 Calendar schedules** (the former checkpoint 7). *(Done 2026-10-01: `npm run proof:schedules`, 10 checks on the packaged app including a real run at the chosen minute; clock-change and downtime rules in `tests/calendar.test.ts` and `tests/workflows.test.ts`; `proof:workflows` and `proof:discovery` re-run green.)* Repeat: never, every N minutes, daily, weekdays, or chosen days, at a local time in the Mac's timezone (stored with the schedule and shown). A time the clocks skip runs that many minutes later (02:30 → 03:30); a time that happens twice runs once, the first time. After downtime a schedule runs once, late, then returns to its days and time. Interval and calendar are exclusive; old workflows load unchanged. Agents still cannot schedule (their save route takes only a name and instructions).
- **U5 Workflow gallery.** *(Done 2026-10-01: `npm run proof:gallery`, 22 checks on the packaged app with the stand-in agent, nothing run; `proof:discovery` and `proof:workflows` re-run green.)* 25 workflows in 6 categories, 4 featured; the five earlier starters are part of it. A suggested schedule is filled into the paused copy and stays off until turned on. Cockpit's own curated workflows (original titles and text, not Enjoy's), grouped by category with counts, a few featured picks, search, and a detail view showing the instructions file, a suggested schedule or "On demand", Add to Workflows and related workflows. Adding copies it and never schedules or runs it. The new-conversation screen points to the gallery while a project has no workflows. Favour workflows that work inside a repository; ones that need mail, calendar or browser access say which tools they rely on. Gate `proof:gallery`.
- **U6 Appearance.** *(Done 2026-10-01: `npm run proof:appearance`, 12 checks on the packaged app with the stand-in agent, including a restart; the theme button it replaces is driven through `setTheme` in `proof-b`, not re-run because that proof uses real Haiku.)* Defaults are the earlier look (agent and date, no preview). A popover in the top bar: System/Light/Dark; Normal/Compact for the conversation list and for messages; what list rows show (message preview, agent, date). Remembered across restarts.
- **U7 App settings, sounds and the app icon.** An app settings panel; optional sounds when an agent replies and when it needs a decision. The app icon shows state from outside the window: it animates while any agent is working (David saw Enjoy's icon do this in the app switcher, 2026-10-01) and carries a badge with the Needs you count. Spike first: Electron's `app.dock.setIcon` frames and `app.dock.setBadge`; confirm the Cmd-Tab switcher picks up the changed icon, keep the frame rate low, and stop animating when nothing is working.
- **U8 Project settings.** Project name, tab tint (a few presets), project image, Open folder in Finder, Remove from Cockpit (never touches the folder). Importing conversations is left out until there is something to import from.
- **U9 Files extras.** Your documents (kept by the app per project, outside the repository) beside Project files; New file choices (Markdown, JSON, plain text, other); rename, pin, archive with an Archived view, delete; Open in default app, Reveal in Finder; an open-tabs menu with Close other tabs and Close all tabs; a footer with Saved state and word count; line numbers in Source view.
- **U10 More agents** (requested 2026-10-01; detail under Phase 8). Gemini CLI first: installed here (0.42), so its headless JSON output or its agent protocol mode can be recorded and parsed like the others. Then Antigravity, only if it offers a headless agent Cockpit can drive (here it is installed as desktop apps; check before planning). OpenRouter through OpenCode's provider support. One adapter per checkpoint, each with recorded-traffic parser tests and a smoke run.
- **U11 Account and plan placeholders.** An account panel that says the preview is free, with a plan card and licence field shown as "coming later". Needs a decision first: this repository has no licence file (all rights reserved by default), and what, if anything, is paid.

Left out, as features that only make sense for a hosted service: Google sign-in, team invites, a keychain for API keys (Cockpit stores none; it uses each CLI's own login), feedback and testimonial forms, community links.

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

Enjoy drives five CLIs: Claude Code, Codex, Grok Build, OpenCode and Antigravity. Requested order (2026-10-01): Gemini CLI, Antigravity, OpenRouter via OpenCode; scheduled as U10 in the second upgrade. Add the remaining three as adapters behind the same `NormalizedEvent` model, one per checkpoint, each with a smoke and a parser test against recorded traffic.
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
