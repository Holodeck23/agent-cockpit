# Architecture

Cockpit is a local Node server that drives the agent CLIs, a React page that talks to it, and an Electron shell that puts the page in a native window. The server is the product; the page and the app are views of it.

```
┌────────────── Cockpit.app (Electron) ──────────────┐
│ main process                                        │
│   server/start.ts  HTTP + SSE on 127.0.0.1:<random> │◄── page (sandboxed, no Node)
│     threads/manager ──► agents/claude  (claude -p)  │
│                     └─► agents/codex   (app-server) │
│     processes/runner ─► dev servers (process groups)│
│     http/mcp-routes  ◄── cockpit MCP (one per       │
│                          agent session, over HTTP)  │
└─────────────────────────────────────────────────────┘
          ~/.agent-cockpit/threads/<id>/{meta.json, events.jsonl, messages.md}
          ~/.agent-cockpit/projects.json
```

## Layout

| Path | Role |
|---|---|
| `server/agents/` | One adapter per CLI. Each turns its wire protocol into `NormalizedEvent` (`types.ts`). `stop.ts` is the shared EOF, SIGTERM, SIGKILL ladder. |
| `server/threads/` | The thread store (files), the manager (live sessions, statuses, approvals, agent switch) and the handoff builder. |
| `server/processes/` | The process runner: long-running project commands, their output buffers and group shutdown. |
| `server/mcp/` | The cockpit MCP server (runs as its own process per session), its tools, session tokens and per-CLI wiring. |
| `server/http/` | The API: loopback guard, JSON helpers, routes for threads, projects, processes and MCP callbacks, and the SSE stream. |
| `server/projects/` | `projects.json`: pinned projects, names and colours. |
| `web/src/` | The React UI. `useCockpit.ts` holds page state fed by one SSE stream; `transcript.ts` turns raw events into what the thread view draws. |
| `electron/` | Main process (window, menu, quit handling), preload (folder picker, theme, reveal transcript) and login-shell PATH. |
| `scripts/` | Build, smoke tests against real CLIs, and proof gates that drive the packaged app. |

## Decisions and why

**Drive the official CLIs instead of calling model APIs.** The point is to use subscriptions already paid for, with each CLI's own tools, permissions and sessions. The cost is tracking two undocumented-in-places wire protocols, which [PROTOCOLS.md](PROTOCOLS.md) records.

**One event model.** Adapters normalize everything into a small union (session, text, tool use and result, approval request and resolution, usage, result, exit, error). Storage, statuses, the transcript and the UI are written once against that, which is what made adding Codex and switching agents mid-thread cheap.

**Files first.** A thread is `meta.json`, an append-only `events.jsonl` and a human-readable `messages.md`. Nothing needs a database, a thread survives a restart, and the transcript is a file an agent (or you) can read. Status is derived from the event log, not stored.

**Electron around the existing server.** Tauri would have needed a bundled Node sidecar or a Rust rewrite of a proven backend; Electron runs `server/*` unchanged in its main process. The page still talks HTTP and SSE, exactly as in a browser, which also keeps the door open for phone access later.

**Security model.** Anything on the machine can reach 127.0.0.1, including a web page in a browser. The guard (`server/http/guard.ts`) requires a loopback Host (against DNS rebinding), a matching Origin when present (against CSRF), and `application/json` on writes (which forces a CORS preflight the server never answers). The page runs with `contextIsolation`, `sandbox` and no Node; the preload exposes three narrow calls, each checking the sender's origin. Every CLI flag comes from a schema allowlist.

**Phone access is a second listener, not a loosened guard.** The desktop listener keeps its random port and loopback guard. Phone access adds a listener on a fixed 127.0.0.1 port (47821) that only `tailscale serve` reaches, proxying `https://<mac>.<tailnet>.ts.net`. Tailscale passes the original Host through, sets `X-Forwarded-Proto: https`, and replaces any client-sent `Tailscale-User-*` headers with the requester's tailnet identity (verified in its source, `ipn/ipnlocal/serve.go`, and live). The phone guard (`server/remote/guard.ts`) requires the loopback socket, the tailnet Host, HTTPS, a login on the allowlist (by default the Mac owner's), a matching Origin, and JSON writes. After that, each phone needs a pairing cookie approved on the Mac: a random token stored only as a SHA-256 hash, bound to the login that paired it, revocable from the Phone panel. The phone can read conversations, reply, answer approvals and stop a turn; opening folders, files, workflows, processes and settings are refused. A local process could forge the Tailscale headers by calling the port directly, but it can already call the desktop API, so that grants nothing new.

**Hooks off by default.** Your own Claude Code hooks merge into every session, and SessionStart hooks can hijack a headless run. Cockpit threads set `disableAllHooks` unless the thread opts in.

**Processes as groups.** `npm run dev` forks: sh, npm, node, a bundler. Killing only the direct child leaves the server holding its port. Each process is spawned `detached` as its own group and stopped as a group (SIGTERM, then SIGKILL after 3 s). Output is split into numbered lines, stripped of terminal codes, capped at 512 KB, and scanned for the first local URL.

**The cockpit MCP talks back over HTTP with a session token.** The MCP server is a separate process the CLI spawns, so it needs a way home. It gets the server URL and a token through its environment. The token is about identity and scope, not secrecy: the loopback API is reachable by any local process anyway. What it adds is that a session's tools see only that session's project, and stop working when the session ends. It is never on a command line: Claude passes its environment to MCP servers, and Codex forwards named variables through `env_vars`.

**Cheap tools don't ask, costly ones do.** Listing, reading logs and opening a localhost preview are pre-allowed. Starting or stopping a process goes through the same approval card as a shell command.

**Quit leaves nothing behind.** Closing the window keeps the app and its agents running (macOS convention). Quitting stops every agent session and every process group before exit, and the packaged-app proofs check for survivors by pid.

## Testing strategy

- **Unit tests** (`tests/`, vitest) for everything pure or local: flag building, both parsers against recorded CLI traffic, the manager with a fake launcher, the guard, the process runner with real child processes, the MCP tools through an in-memory MCP client against real routes.
- **Smokes** (`scripts/smoke-*.ts`) run real CLIs on small models, outside the app.
- **Proof gates** (`scripts/proof-*.ts`) launch the packaged `Cockpit.app` through Playwright's Electron driver with launchd's bare PATH, run real Haiku conversations, click through the UI, check state through the API and by pid, and save screenshots to `docs/proof/`. Waits poll from Node, because Playwright's `waitForFunction` does not await an async predicate (a Promise is truthy), which once let a gate pass on stale state.
