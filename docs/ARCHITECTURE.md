# Architecture

Cockpit is a local Node server that drives the agent CLIs, a React page that talks to it, and an Electron shell that puts the page in a native window. The server is the product; the page and the app are views of it.

```
┌──────────────── Cockpit.app (Electron) ─────────────────┐
│ main process                                             │
│   window key ── added to the Cockpit window's /api calls │
│   server/start.ts  HTTP + SSE on 127.0.0.1:<random>      │◄── page (sandboxed, no Node)
│     threads/manager ──► agents/claude      (claude -p)   │
│                     ├─► agents/codex       (app-server)  │
│                     ├─► agents/antigravity (agy)         │
│                     └─► agents/acp         (opencode acp)│
│     processes/runner ─► dev servers (process groups)     │
│     http/mcp-routes  ◄── cockpit MCP (one per agent      │
│                          session, over HTTP + token)     │
│     remote/service   ◄── phone listener (tailscale serve)│
└──────────────────────────────────────────────────────────┘
          ~/.agent-cockpit/threads/<id>/{meta.json, events.jsonl, messages.md}
          ~/.agent-cockpit/attachments/<id>/   images sent and received
          ~/.agent-cockpit/{projects,workflows,memory,presets,remote,push}.json
```

## Layout

| Path | Role |
|---|---|
| `server/agents/` | One adapter per CLI (`claude`, `codex`, `antigravity`, and `acp` for OpenCode). Each turns its wire protocol into `NormalizedEvent` (`types.ts`). `stop.ts` is the shared EOF, SIGTERM, SIGKILL ladder; `stdin.ts` keeps a closed agent pipe from throwing. |
| `server/threads/` | The thread store (files), the manager (live sessions, statuses, approvals, agent switch) and the handoff builder. |
| `server/processes/` | The process runner: long-running project commands, their output buffers and group shutdown. |
| `server/mcp/` | The cockpit MCP server (runs as its own process per session), its tools, session tokens and per-CLI wiring. |
| `server/http/` | The API: loopback guard, JSON helpers, routes for threads, projects, processes and MCP callbacks, and the SSE stream. |
| `server/remote/` | Tailscale listener, identity guard, paired-device store, encrypted Web Push subscriptions and approval notifications. |
| `server/workflows/` | Saved instructions, prompt expansion and schedules while the app is running. |
| `server/files/` | Bounded project file access and attachment expansion. |
| `server/projects/` | `projects.json`: pinned projects, names and colours. |
| `web/src/` | The React UI. `useCockpit.ts` holds page state fed by one SSE stream; `transcript.ts` turns raw events into what the thread view draws. |
| `electron/` | Main process (window, menu, quit handling, update check, Dock activity), the window key (`window-key.ts`), the preload bridge and login-shell PATH. |
| `scripts/` | Build, smoke tests against real CLIs, and proof gates that drive the packaged app. |

## Decisions and why

**Drive the official CLIs instead of calling model APIs.** The point is to use subscriptions already paid for, with each CLI's own tools, permissions and sessions. The cost is tracking two undocumented-in-places wire protocols, which [PROTOCOLS.md](PROTOCOLS.md) records.

**One event model.** Adapters normalize everything into a small union (session, text, tool use and result, approval request and resolution, usage, result, exit, error). Storage, statuses, the transcript and the UI are written once against that, which is what made adding Codex and switching agents mid-thread cheap.

**Files first.** A thread is `meta.json`, an append-only `events.jsonl` and a human-readable `messages.md`. Nothing needs a database, a thread survives a restart, and the transcript is a file an agent (or you) can read. Status is derived from the event log, not stored. Because one damaged conversation must not hide the rest (the list reads them all), reads are tolerant. A line that does not parse as an event (half a line after a crash, a power cut or a full disk) is skipped. A `meta.json` that does not parse leaves its conversation out of the list. Each case is reported once, and the file is never rewritten. The first append to a log in each process checks for a missing final newline, so a new event never joins a half line.

**Electron around the existing server.** Tauri would have needed a bundled Node sidecar or a Rust rewrite of a proven backend; Electron runs `server/*` unchanged in its main process. The page still talks HTTP and SSE, exactly as in a browser, which also supports the paired phone view.

**Security model.** Anything on the machine can reach 127.0.0.1, including a web page in a browser. The guard (`server/http/guard.ts`) requires a loopback Host (against DNS rebinding), a matching Origin when present (against CSRF), and `application/json` on writes (which forces a CORS preflight the server never answers). The page runs with `contextIsolation`, `sandbox` and no Node. The preload bridge (`electron/preload.ts`) is the page's only native surface: native folder and new-project panels, theme, clipboard, notifications, Dock activity, the preview pane, and opening, revealing, trashing or copying in files of a project Cockpit already lists. The main process checks every call's sender origin and re-checks paths against the known projects and the thread folder. Every CLI flag comes from a schema allowlist.

**The window key.** The guard stops web pages, not other programs: any local process, an agent's shell included, can send any Host, Origin and Content-Type. So the desktop app makes a random key at each launch and requires it on every `/api` request except `/api/mcp`, which has its own session tokens. The main process adds the header in `onBeforeSendHeaders`, and only for requests from the main window's own top frame while it shows Cockpit's page. The preview iframe and the hidden capture window never get it, and a page-supplied value is stripped. The key exists only in main-process memory: not in env, argv, a file or the preload. Without it an agent could approve its own approval requests over HTTP. `npm start` runs without a key and warns that any local program can use its API.

**Phone access is a second listener, not a loosened guard.** The desktop listener keeps its random port and loopback guard. Phone access adds a listener on a fixed 127.0.0.1 port (47821) that only `tailscale serve` reaches, proxying `https://<mac>.<tailnet>.ts.net`. Tailscale passes the original Host through, sets `X-Forwarded-Proto: https`, and replaces any client-sent `Tailscale-User-*` headers with the requester's tailnet identity (verified in its source, `ipn/ipnlocal/serve.go`, and live). The phone guard (`server/remote/guard.ts`) requires the loopback socket, the tailnet Host, HTTPS, a login on the allowlist (by default the Mac owner's), a matching Origin, and JSON writes. After that, each phone needs a pairing cookie approved on the Mac: a random token stored only as a SHA-256 hash, bound to the login that paired it, revocable from the Phone panel. The phone can read conversations, reply, answer approvals and stop a turn; opening folders, reading project files, editing workflows, controlling processes and changing settings are refused. A local process could forge the Tailscale headers by calling the port directly, but it can already call the desktop API, so that grants nothing new.

**Phone notifications.** `server/remote/push.ts` stores VAPID signing keys and paired-phone subscriptions in `push.json` under the private state directory, with mode 0600. A live approval request sends the project name, conversation title and id encrypted through Web Push. Sending is gated on phone access running and the device remaining paired. Revocation removes subscriptions; normal delivery removes expired endpoints on HTTP 404/410. Push requests use a 15-second socket timeout. The phone registers `web/public/sw.js`, waits for activation and reconciles browser subscription state with the Mac. A notification tap opens `/?thread=<id>`. Payloads can appear on the phone lock screen. Tests verify the server flow using an injected sender; physical-device delivery and tapping remain separate acceptance checks.

**Hooks off by default.** Your own Claude Code hooks merge into every session, and SessionStart hooks can hijack a headless run. Cockpit threads set `disableAllHooks` unless the thread opts in.

**Agent pipes never take the server down.** The server runs in Electron's main process beside every other conversation, so one agent's failure must stay in its conversation. A CLI that exits or closes stdin still looks writable until Node handles its exit, and the next write fails asynchronously with EPIPE. Every adapter attaches an error handler to the agent's stdin (`agents/stdin.ts`): the lost write becomes an error event in that conversation, and the exit handler ends the session as usual. Events from an agent are recorded inside a guard too, so a write that fails (a full disk) loses that event instead of throwing out of a stream handler.

**Processes as groups.** `npm run dev` forks: sh, npm, node, a bundler. Killing only the direct child leaves the server holding its port. Each process is spawned `detached` as its own group and stopped as a group (SIGTERM, then SIGKILL after 3 s). Output is split into numbered lines, stripped of terminal codes, capped at 512 KB, and scanned for the first local URL.

**The cockpit MCP talks back over HTTP with a session token.** The MCP server is a separate process the CLI spawns, so it needs a way home. It gets the server URL and a token through its environment. The token is about identity and scope, not secrecy: the loopback API is reachable by any local process anyway. What it adds is that a session's tools see only that session's project, and stop working when the session ends. It is never on a command line: Claude passes its environment to MCP servers, and Codex forwards named variables through `env_vars`.

**Cheap tools don't ask, costly ones do.** Listing, reading logs, opening a localhost preview and capturing its screenshot are pre-allowed. `open_preview` sends the loopback URL to a resizable iframe in the sandboxed page. `inspect_preview` uses a short-lived sandboxed Chromium window and returns a normalized 1280×800 PNG to the agent. Both reject non-loopback targets; the embedded frame cannot navigate to a remote origin. Starting or stopping a process goes through the same approval card as a shell command.

**Quit leaves nothing behind.** Closing the window keeps the app and its agents running (macOS convention). Quitting stops every agent session and every process group before exit, and the packaged-app proofs check for survivors by pid.

## Testing strategy

- **Unit tests** (`tests/`, vitest, on macOS in CI) for everything pure or local, including stand-in CLIs that die mid-write and conversation files damaged on disk: flag building, both parsers against recorded CLI traffic, the manager with a fake launcher, the guard, the process runner with real child processes, the MCP tools through an in-memory MCP client against real routes.
- **Smokes** (`scripts/smoke-*.ts`) run real CLIs on small models, outside the app.
- **Proof gates** (`scripts/proof-*.ts`) launch the packaged `Cockpit.app` through Playwright's Electron driver with launchd's bare PATH, run real Haiku conversations, click through the UI, check state through the API and by pid, and save screenshots to `docs/proof/`. Waits poll from Node, because Playwright's `waitForFunction` does not await an async predicate (a Promise is truthy), which once let a gate pass on stale state.

## Setup independence

State defaults to the current operating-system user's home directory; `COCKPIT_HOME` provides explicit isolation for tests. CLI discovery uses that user's login-shell PATH with standard installation fallbacks. Tailscale discovery follows the resolved PATH before standard Mac locations. Tailscale identity is read at runtime; every installation approves and stores its own phone pairing and generates its own Web Push signing keys. A blank model field delegates model selection to the selected CLI's configuration. `npm run doctor` checks local prerequisites without attempting sign-in or running agent turns.
