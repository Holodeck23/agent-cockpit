# Agent Cockpit: a real Mac app with an Enjoy-clone UI

## Context
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

## Then (unchanged from the previous plan)
Phase 4 cockpit MCP → Phase 5 workflows + schedule (fills in the Files/Workflows tabs) → Phase 6 phone (Tailscale, not installed) → Phase 7 preview pane.

## Verification
- Every checkpoint: `npm run verify` (typecheck + 30+ tests + builds) and the `npm run smoke:claude` / `smoke:codex` smokes.
- A packaged-app proof via Playwright `_electron`, with screenshots in `docs/proof/`.
- One commit per checkpoint. The repo has no remote and stays that way.
- Final: `release/mac-arm64/Cockpit.app` exists and launches from Finder. Installing is one copy to /Applications.
