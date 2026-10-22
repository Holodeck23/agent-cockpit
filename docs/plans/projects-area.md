# Plan: the Projects area

Runbook and environment: [README.md](README.md). Goal in one sentence: **everything you're working on, in one calm place.**

## Decisions

| # | Decision |
|---|---|
| D1 | Three nouns only: **Area → Project → Conversation.** Repos, files and workflows live inside a project. Never call an area a "workspace": in Cockpit that word means a worktree (`server/projects/workspaces.ts`). |
| D2 | **Pinned = tab.** Unpinned projects live on the Map and in the sidebar. A tab's × unpins it; the project stays in Cockpit. Tabs drag to reorder. Right-click a tab: colour, pin/unpin, close, project settings, remove. |
| D3 | A left **sidebar** (the tree, compact, desktop only) and a **Map** (Home, the visual overview). Same data, two densities. |
| D4 | **Libraries:** the person adds folders as libraries. Cockpit proposes areas from the folder structure; the person renames, hides and regroups them without anything moving on disk. **No library is added by default.** |
| D5 | **Agent-OS layers:** each project shows six layers read from disk (Identity, Substrate, Rules & hooks, Skills, Tools, Agents). An os-coach `memory.md` "Layer status" block is honoured where present. Any folder can be grown into an OS. |
| D6 | **Mac only:** a library or area can be marked Mac only. Its projects never reach the phone, its memories never go "everywhere", and its paths are scrubbed from crash reports. |
| D7 | **Calm by default:** only "needs you" gets colour or motion; at most five things on a card; conversations older than 14 days fold under "Earlier". Every new element must pass: a stranger can name it, the default is right, it responds within a beat, someone would miss it if it vanished. |
| D8 | **Mockup before the UI build.** A person approves a clickable mockup before Moves 5–8 and 10. |

## Facts the plan depends on (read from the code)

**Projects today**
- `server/projects/store.ts`: `projects.json` is a flat array (`path, name, color, pinned, pinOrder?, lastOpenedAt, instructions?, image?, hidden?, pinnedFiles?, agentWorkflows?, antigravityMcp?`). `read()` parses with `z.array(projectSchema)` and `write()` writes the parsed result.
- **Why navigation.json:** because `write()` writes back only the fields a build knows, an older Cockpit build that opens the same data silently deletes any newer field. Several older builds can be on one Mac under the same bundle id. So all new navigation state goes in a separate `navigation.json`; `projects.json` keeps its current fields only.
- `ensure()` registers every folder that has conversations; `open()` creates or updates and stamps `lastOpenedAt`; `hide()` is "Remove from Cockpit". `projectPatchSchema` already allows `color`; `pinChange` already maintains `pinOrder`.
- Tabs: `web/src/project-tabs.ts` `tabOrder` = pinned projects by `pinOrder`, then the active project if unpinned. `web/src/components/ProjectTabBar.tsx` renders `role="tab"` in a `tablist` labelled "Projects", with a pin button on the active tab only. There is no ×, no drag and no context menu.
- `web/src/components/ProjectsMenu.tsx`: the "Projects" button opens the "Projects" menu (`.project-row`s, Remove, settings, open folder, import).
- Routes in `server/http/router.ts`: `GET /api/projects` (runs `ensure`), `POST /api/projects {path, ...patch}`, `POST /api/projects/remove`, `/image`, `/pins`, `/agy-mcp`; thread search `GET /api/threads/search?q=&projectPath=`.
- Shortcuts (`web/src/shortcuts.ts`): ⌘1–8 tab n, ⌘9 last tab, ⌥⌘1–5 sections.

**Proof constraints**
- `scripts/lib/ui.ts` `openProject()` (used about 67 times across proofs) POSTs `{path, pinned:true}`, reloads, and waits for `getByRole('tab', { selected: true }).first()`. Anything with `role="tab"` and `aria-selected` rendered before the tab bar would capture that locator. **The sidebar and Map use `tree`/`treeitem`/`button`/`link` with `aria-current`, never `tab`.**
- About 11 proofs drive the "Projects" button and menu (`proof-wave-4`, `proof-b`, `proof-accounts`, `proof-antigravity`, `proof-instructions`, `proof-reliability`, `proof-wave-10`, `proof-import`, `proof-project-settings`, `proof-wave-2`, `proof-wave-9`). **That menu keeps its names and rows.**
- The release gate is the suite list in `scripts/lib/gate-suites.ts`.

**Phone and privacy**
- Phone requests go through `server/remote/service.ts` to `api(req, res, true)` (`viaPhone`); the allowed routes are `ROUTES` in `server/remote/routes.ts`.
- The live stream `openSse(req, res, manager, processes, viaPhone ? undefined : remote)` (`server/http/sse.ts`) forwards every thread update and process event unfiltered.
- Memory (`server/memory/store.ts`) has scopes `project | everywhere`; "everywhere" reaches agents in every project.
- Crash reports (`electron/telemetry-choice.ts` `scrubString`) only replace the home folder with `~`; deeper folder names and paths outside home are sent as they are.

**os-coach layout** (read the format, never copy its files: no licence is published): an OS root has `CLAUDE.md` (identity), `substrate/`, `rules/`, `skills/`, `tools.md`, `agents/`, `memory.md` with a `## Layer status` block of lines `- <Layer>: <not started | in progress | solid> - <note>`, and `OS-AUDIT.md`.

**Styling:** a restyle branch (`feat/lumen-redesign`) changes `web/src/styles/*`. New UI uses only CSS variables from `web/src/styles/tokens.css`, never literal colours, so either look applies.

## Moves

### Move 0: base
- **Do**: per README. Branches `feat/projects-area-<move>` from the base. Re-count: `grep -o "openProject(" scripts/*.ts | wc -l` and `grep -rn 'role="tab"' web/src/components/*.tsx`.
- **Expect**: counts within about 10% of the facts above.
- **Fork**: if the restyle branch is merged into the base, use its tokens; if not, tokens only, and do not merge it here.

### Move 1: clickable mockup (no product code)
- **Do**: one self-contained file `docs/plans/mockup/projects-area.html` (≤ 600 lines, no build step, no external requests) with invented data: three libraries ("Code", "Notes", "Private", the last Mac only), six areas, about twenty projects with invented names, two sub-projects, a "Shelf" area collapsed, one project needing attention. Shows: tab bar (× on each tab, drag to reorder, right-click colour menu), sidebar tree with an "Earlier" fold, Map cards with the six-layer ring, light and dark, and a 390 px narrow state.
- **Expect**: opening the file in a browser shows all of the above working; committed and pushed; path reported.
- **Stop**: Moves 5–8 and 10 wait for a person's approval of this mockup. If changes are requested, update Decisions and this plan first.

### Move 2: library scanner (server, pure)
- **Do**: `server/projects/libraries.ts`: `scanLibrary(library, others, fs)` → `{ areas: [{ id, name, root, private, shelf, projects: [{ path, name, children, layers, lastChangedAt }] }], truncated }`. Rules:
  - Resolve every path with `realpath`. Skip a symlink whose target lies inside another library. Skip dot-folders, `node_modules`. Depth ≤ 3; stop after 2,000 directories per library and set `truncated`.
  - Each top-level folder = an area (display name = folder name). Its child folders = projects. Top-level folders named `parked`, `archive`, `archived`, `third-party`, `vendor` = areas with `shelf: true`.
  - A top-level folder that is itself a project (has `.git`, `CLAUDE.md` or `AGENTS.md`) = a project in an area named "Loose". Display names are trimmed.
  - Sub-projects: a project whose real path is inside another project's real path nests under the deepest one.
  - Known projects from `projects.json` merge by real path.
  - Layers, by `stat` only (no file reads except `memory.md`): Identity = `CLAUDE.md` | `AGENTS.md`; Substrate = `substrate/` | `context/` | `knowledge/` | `_raw/` | `research/`; Rules = `rules/` | `.claude/rules/` | `.claude/settings.json`; Skills = `skills/` | `.claude/skills/`; Tools = `tools.md` | `.mcp.json`; Agents = `agents/` | `.claude/agents/`. A `memory.md` `## Layer status` block overrides. `lastChangedAt` per layer = that entry's own mtime.
- **Expect**: `tests/libraries.test.ts` on a temp tree covers every rule, including a symlink into another library, a symlink loop, a shelf, a Loose project and a sub-project; asserts every returned path is unique.
- **Most likely failure**: one folder listed twice. Cause: literal paths compared. Counter: realpath at the boundary, uniqueness assertion.

### Move 3: navigation store
- **Do**: `server/projects/navigation.ts`, `<COCKPIT_HOME>/navigation.json`, atomic writes (`writeFileAtomic`), `StoreReadError` when unreadable (same discipline as `store.ts`). Schema v1: `{ version: 1, libraries: [{ root, private? }], areas: [{ id, name, private?, hidden?, order }], placement: { [realPath]: areaId }, names: { [realPath]: string }, collapsed: [areaId] }`. Parse loosely and write back unknown keys untouched, so a newer build's fields survive an older one.
- Routes: `GET /api/map` (library scans cached in memory for 60 s, refreshed on app focus or `?refresh=1`; merged with known projects, placement, names and per-project status counts from `manager.summaries()`); `POST /api/navigation` (add/remove library, rename/hide/create/reorder area, move project, set Mac only, collapse); `POST /api/projects/order { paths }` rewrites `pinOrder` 1..n (existing field).
- **Expect**: unit tests for read, every patch, and unknown-key survival. After all Move 3 actions, `projects.json` only ever changes in `pinOrder`, `pinned`, `color`, `lastOpenedAt`.
- **Abort**: any proposal to add a key to `projects.json`.

### Move 4: tabs (first shippable piece)
- **Do**: `ProjectTabBar.tsx`: × on every tab (`aria-label="Close <name>"`) unpins; if it was the active tab, select the next tab, or the Map when none remain. Drag to reorder (start after 4 px of movement so a click still selects), drop → `POST /api/projects/order`. Keyboard reorder ⌥⇧← / ⌥⇧→ on a focused tab. Context menu (`role="menu"`, right-click and Shift+F10): the six colours, Pin/Unpin, Close, Project settings…, Remove from Cockpit…. Keep the existing pin button.
- **Expect**: unit tests for `tabOrder` after reordering; packaged proof `scripts/proof-tabs.ts` (`npm run proof:tabs`, NAV-01–05) written: pin three projects → drag the third to first → ⌘1 opens it → × closes it → it is still in the Projects menu → right-click → pink → the tab has `tint-pink`. Add `{ name: 'tabs', script: 'proof:tabs', covers: ['NAV-01–NAV-05'] }` to `gate-suites.ts`.
- **Most likely failure**: drag swallows clicks. Counter: the 4 px threshold, tested both ways.

### Move 5: sidebar (after mockup approval)
- **Do**: `web/src/components/Sidebar.tsx`, desktop only (`!phone`), resizable like the conversation list, collapsible (state in localStorage `cockpit:sidebar`, read and written inside try/catch; a ⌘\ shortcut only if `grep -rn "Backslash" web/src electron` finds nothing). From `GET /api/map`: areas (shelves collapsed) → projects → sub-projects; a project expands to its 5 newest conversations + "All conversations", older than 14 days under "Earlier". Status: needs you = accent + count; working = a quiet pulse; otherwise nothing. `role="tree"`, rows `treeitem`, current row `aria-current="page"`. Top rows: "Home" (Map) and "Search" (Move 8). Selecting a project opens it WITHOUT pinning (`POST /api/projects {path}`).
- **Expect**: in the running app, `document.querySelectorAll('[role=tab][aria-selected=true]')[0].closest('.tabbar')` is not null. Unit tests for tree flattening and the Earlier fold.
- **Most likely failure**: opening from the sidebar pins. Counter: never send `pinned` from the sidebar.

### Move 6: the Map (Home)
- **Do**: `web/src/components/MapView.tsx`, shown when no project is selected or Home is chosen (`home` state beside `section` in `App.tsx`; a ⇧⌘H shortcut only if `grep -rn "KeyH" web/src electron` finds nothing; never ⌘0, Electron's Actual Size). Areas in `order`; each project is a card with exactly: avatar/colour, name, status, last active, six-layer ring. Sub-projects as chips on the parent card. ⋯ menu: Pin as tab, Move to area…, Rename…, Open folder, Mac only. Shelves collapse to one line ("Shelf · 12"). No libraries yet → one sentence and "Add a folder".
- Layer ring: six segments in build order (Identity, Substrate, Rules, Skills, Tools, Agents); filled = present or solid, half = in progress, empty = missing; a segment untouched for 30 days turns grey (no alert). Tooltip names each layer in plain words.
- **Expect**: packaged proof `scripts/proof-map.ts` (`proof:map`, NAV-06–10) written: temp COCKPIT_HOME with a fixture library → three areas; a fixture with `CLAUDE.md`, `rules/`, `skills/` shows three filled segments; a stand-in agent question shows "needs you" on its card; Pin as tab adds a tab; light, dark and narrow screenshots of fixture data only.
- **Most likely failure**: noise (paths, counts). Counter: apply D7's test to every element before writing the proof.

### Move 7: areas you arrange
- **Do**: drag a card to another area; New area; Rename; Hide; reorder areas. All through `POST /api/navigation`. Nothing on disk moves.
- **Expect**: tests assert the library's directory listing is identical before and after; `proof:map` extended: move a project into a new area, reload, still there.

### Move 8: ⌘K search
- **Do**: one dialog over projects (known + library), conversations (`/api/threads/search`) and, if a files search endpoint exists (`grep -rn "search" server/files | head`), the active project's files. Enter opens. If a command palette already exists in the base, extend it instead.
- **Expect**: `proof:map` step: ⌘K, type part of a fixture name, Enter opens it.

### Move 9: Mac only
- **Do**: `server/projects/privacy.ts` `macOnly(projectPath)` (true when the project's real path is inside a private library or area). Apply:
  1. With `viaPhone`: filter `GET /api/projects`, `GET /api/threads`, `GET /api/threads/search`, `GET /api/map`; any `/api/threads/:id…` on a Mac-only thread → 404 "Not available from the phone".
  2. `openSse` for the phone: drop thread updates of Mac-only threads and process events of Mac-only projects (add a filter parameter).
  3. Push (`server/remote/push.ts`): never for Mac-only threads (if its input has no thread or project id, add one).
  4. Memory: `remember` with scope `everywhere` from a Mac-only project is saved as `project`, and the approval card says so.
  5. Crash reports: `scrubString` also replaces each private root (real path) with `<private>`; roots passed at startup from `navigation.json`.
- **Expect**: `tests/privacy-phone.test.ts` iterates EVERY entry of `ROUTES` with a Mac-only fixture project and asserts no response body or stream frame contains its path, title or text; a telemetry test turns a private root into `<private>/…`.
- **Abort**: any phone-visible leak found after merge stops all other work until fixed.

### Move 10: grow this OS
- **Do**: card ⋯ and project header: "Grow this OS" opens a new conversation in that project with the composer PREFILLED, never sent: `/os-coach audit` if an `os-coach` skill is installed for the chosen agent (Claude Code: `~/.claude/skills/os-coach/SKILL.md` exists), otherwise: "Look at this folder as an AI operating system with six layers: identity, substrate, rules and hooks, skills, tools, agents. Score each as missing, started, solid or compounding against what this folder is for, then name the three moves that matter most, in order. Do not change any files." A card shows "Next: <first missing layer>" only when three or more layers are missing.
- **Expect**: proof step: Grow → composer holds the prompt, nothing sent.

### Move 11: verify, document, merge
- **Do**: Verification list; user guide pages in `docs/user/` for tabs, the Map, libraries and Mac only. Pull requests by group: (4), (2+3), (5+6+7), (8), (9), (10).

## Abort conditions

- A new key in `projects.json`.
- `openProject()`-based proofs fail after Move 5.
- A library scan writes anything.
- A real person's folder, project or client name in a committed fixture, screenshot or the mockup (the repository is public).
- Failures in gate suites unrelated to navigation: report, do not fix them here.

## Verification

1. Each move: `npm run typecheck && npx vitest run <its tests>`.
2. Each pull request: macOS CI green (includes `check:paths`).
3. Mac, each UI pull request: `npm run package:proof`, wait about 30 s, then `proof:tabs` / `proof:map` three times (3/3), plus `proof:b`, `proof:wave-4`, `proof:project-settings` once.
4. Mac, before the last pull request: the full gate once on one package (`scripts/gate.ts`).
5. Mac, after Move 9: the privacy test green, then a real phone: no Mac-only project listed, and a question in a Mac-only conversation sends no push.
6. A person uses the installed build for 20 minutes (tabs, Map, an area move, Mac only). Anything they can't name becomes a fix before release.

## Red-team record

- Failed attack: "Store areas on the project record." An older build rewrites `projects.json` and drops the field. Patch: `navigation.json` with unknown-key survival.
- Landed attack: "Sidebar rows as tabs." Would capture the `openProject()` locator across the proofs. Patch: D3 roles, Move 5's DOM check.
- Landed attack: "Scan every library the same way." Libraries can contain symlinks into each other, doubling folders and leaking a private flag onto shared ones. Patch: realpath, skip symlinks into another library, uniqueness test.
- Landed attack: "Mac only = hide from the phone's project list." The live stream and push would still carry it. Patch: Move 9 covers stream, push, threads, search, memory scope and crash reports, with a test over every phone route.
- Failed attack: "Bundle os-coach." No licence is published; Cockpit only reads a folder's own `memory.md` and prefills `/os-coach` when it is installed.
