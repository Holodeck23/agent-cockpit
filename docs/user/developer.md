# Developer Guide

> **v0.1.5 prerelease (2026-10-07).** This guide describes `main`. See the [tester checklist](tester-checklist.md).

This page is for building, testing and packaging Cockpit. The code is published to be read. Changing or redistributing it needs written permission (see [LICENSE](../../LICENSE)).

## How it fits together

```
Cockpit window (React) ──HTTP + SSE──►  local server (Node, 127.0.0.1, random port)
                                         ├─ claude -p          stream-json over stdio, approvals over stdio
                                         ├─ codex app-server   JSON-RPC over stdio
                                         ├─ agy                stream-json over stdio, subscription credentials
                                         ├─ opencode acp       Agent Client Protocol over stdio
                                         ├─ process runner     dev servers, one process group each
                                         └─ ~/.agent-cockpit/  threads as plain files
         each agent session ──stdio──►  cockpit MCP server ──HTTP + session token──► local server
```

-   **Adapters** turn each CLI's wire protocol into one event model.
-   **The desktop app** runs the same server inside Electron's main process. The page is sandboxed with no Node. Only the Cockpit window can use the desktop API (a per-launch key the main process adds to that window's requests).
-   **Phone access** is a second listener on `127.0.0.1` that only `tailscale serve` reaches, with pairing on top. Phone previews add one listener per app.
-   **State** is plain files in `~/.agent-cockpit/`, or the folder in `COCKPIT_HOME`.
-   More: [architecture and decisions](../ARCHITECTURE.md) and [CLI protocol notes](../PROTOCOLS.md).

## Prerequisites

-   **A Mac with Apple silicon** to package or run the app and the packaged proofs. `npm run check:paths`, `npm run typecheck` and `npm test` also run on Linux.
-   **Node.js and npm.** CI uses Node 22 with npm. Other versions are untested here.
-   **Agent CLIs** only for the live smokes and the proofs that say so below. Install them from [installation](index.md#agent-clis).
-   Install the dependencies from the repository root:

```bash
npm ci
```

If Electron's binary is missing afterwards (npm can block install scripts, and Electron fetches its binary lazily), run `node node_modules/electron/install.js` once. CI sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` because its checks never launch Electron.

## Commands

| Command | What it does |
| :--- | :--- |
| `npm run verify` | The same checks as CI: `check:paths`, `typecheck`, `test`, `build`, `build:electron`. Run it before every pull request. |
| `npm run check:paths` | Fails if any tracked file contains an absolute home path such as `/Users/<name>` or `/home/<name>`. This repository is public. Use `~/.agent-cockpit` or `<project>` style placeholders in code and docs. |
| `npm run typecheck` | TypeScript, no emit. |
| `npm test` | Unit tests (vitest). They also pass on Linux. One test needs an ordinary account because it relies on file permissions that `root` ignores, so it is skipped as root. When a test spawns a stand-in CLI, copy the pattern in `tests/claude-capabilities.test.ts`, and allow for macOS scanning a fresh executable on its first run. |
| `npm run doctor` | Read-only check of the platform, the installed agent CLIs and Tailscale. It does not sign in, call agents or change configuration. |
| `npm run dev:server` | The backend with hot reload (`tsx watch`). |
| `npm run dev:web` | The Vite dev server for the page. |
| `npm start` | The backend on port 4317 (`COCKPIT_PORT` overrides it) without the desktop window key, so it warns that any local program can use its API. Build first with `npm run build` and `npm run build:electron`. |
| `npm run app` | Builds, then opens the Electron app from the source tree. |
| `npm run build` / `npm run build:electron` | The page (Vite, into `dist/`) and the Electron main process, preload and MCP bundle (into `dist-electron/`). |
| `npm run package` | A **release** build: `Cockpit.app` at `release/mac-arm64/Cockpit.app` and the installer at `release/Cockpit-<version>-arm64.dmg`. Ad-hoc signed, not notarized. A release build refuses debugger switches, so the proofs cannot drive it. |
| `npm run package:proof` | A proof build with no installer, at `release/proof/mac-arm64/Cockpit.app`. This is what the packaged proofs run against. |
| `npm run check:installers` | Fetches each official agent installer and compares its hash with the pinned review in `server/agents/lifecycle/plans.ts`. It reaches the vendors' sites. The release runner runs it. |
| `npm run release -- <stage> <version>` | The scripted prerelease. See [Releasing](#releasing). |

## Testing and proofs

**Unit tests** (`npm test`) cover anything pure or local: both protocol parsers against recorded traffic, the thread manager with a fake launcher, the guards, the process runner with real child processes, and the MCP tools through an in-memory client against real routes. CI runs them on macOS.

**Packaged proofs** drive the real packaged app through Playwright. Build the proof app, wait about a minute (macOS scans fresh binaries), then run one proof at a time:

```bash
npm run package:proof
COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:<name>
```

Proofs write screenshots to `docs/proof/` unless you set `COCKPIT_PROOF_DIR=<folder>`. Set it so a run does not change tracked images. Do not run proofs that call real providers, or that need Tailscale, unless you mean to. Check the header comment in `scripts/proof-<name>.ts` first.

**Proofs with stand-in CLIs and no provider cost** run against recorded stand-ins in `scripts/fixtures/` and a throwaway home:

`proof:reliability`, `proof:director`, `proof:recovery`, `proof:startup`, `proof:wave-1`, `proof:wave-2`, `proof:wave-3`, `proof:wave-4`, `proof:wave-5`, `proof:wave-6`, `proof:wave-6.5`, `proof:wave-7`, `proof:wave-9`, `proof:wave-10`, `proof:wave-11` (phone preview, against a stand-in `tailscale`), `proof:cross-wave`, `proof:scanner`, `proof:handoff`, `proof:crash-guard`, `proof:quit`, `proof:window-key`, `proof:agents`, `proof:antigravity`, `proof:opencode`, `proof:agent-controls`, `proof:conversation-read`, `proof:appearance`, `proof:dock`, `proof:settings`, `proof:schedules`, `proof:gallery`, `proof:discovery`, `proof:files-extras`, `proof:import`, `proof:lifecycle`, `proof:memory`, `proof:preview`, `proof:processes`, `proof:project-settings`, `proof:thread-menu`, `proof:git`, `proof:edit`, `proof:docs`, `proof:context`, `proof:open-file`.

Notes: `proof:activity` is stand-in too, but it has a live part that runs one real Codex task. Pass `--no-live` to skip it. `proof:updates` calls no provider but reads the real GitHub release feed and needs an app built with an older version (see its header).

**Proofs that drive real providers and use your allowance** (a few cents each, with your own signed-in CLIs):

| Proof | What it spends |
| :--- | :--- |
| `proof:app` | A real Claude Haiku thread. |
| `proof:mcp` | A real agent: Claude Haiku, or Codex with `--codex`. Set `COCKPIT_CODEX_MODEL` for Codex. |
| `proof:workflows` | Real Codex turns. |
| `proof:files` | One real agent turn (Claude, or Codex with `--codex`). |
| `proof:instructions` | Real Claude Haiku and Codex turns. |
| `proof:limit` | Free stand-in, plus one short real Codex turn. |
| `proof:activity` | One real Codex task unless `--no-live`. |
| `proof:onboarding -- --live` | Real provider conversations, timed. Refuses to run without `--live`. |

**Proof that needs real Tailscale:** `proof:phone` turns phone access on for real (`tailscale serve` on HTTPS 10000) and off again at the end. It needs Tailscale installed and logged in. It has an optional real-agent part with `--live`.

Two older scripts, `scripts/proof-b.ts` (`b1`, `b2`, `b3`) and `scripts/proof-ui.ts`, are not npm scripts. Run them with `tsx`. They use real Claude Haiku threads.

**Live smokes** run real CLIs outside the app and use your allowance:

*   `npm run smoke:claude` (two turns in two processes, Haiku)
*   `npm run smoke:codex` (set `COCKPIT_CODEX_MODEL` to choose a model)
*   `npm run smoke:antigravity`
*   `npm run smoke:mcp [claude|codex]` (builds the MCP bundle first)
*   `npm run smoke:updates` reads the real GitHub release feed and calls no provider.

`scripts/smoke-claude-compatibility.ts` is a real-provider gate for one exact Claude CLI and is run with `tsx` and a private evidence folder.

**Environment variables for development**

| Variable | Use |
| :--- | :--- |
| `COCKPIT_HOME` | The state folder (default `~/.agent-cockpit`). Gives a run its own isolated state and Electron profile. |
| `COCKPIT_PORT` | Port for `npm start` (default 4317). |
| `COCKPIT_AGENT_PATH` | Folders searched for agent CLIs before everything else. Proofs use it to point at stand-ins. |
| `COCKPIT_APP` | The `Cockpit.app` a proof drives. |
| `COCKPIT_PROOF_DIR` | Where proofs save screenshots (default `docs/proof`). |
| `COCKPIT_CODEX_MODEL` | A Codex model your account has, for the proofs and smokes that use Codex. |

## Releasing

Releases are Apple-silicon prereleases on GitHub, announced by the landing page and offered by **Check for Updates**. `scripts/release.ts` runs them in four stages. Each checks its own preconditions, so a failed stage can be re-run alone.

1.  `npm run release -- prepare 0.1.6` on the branch being released. It bumps `package.json` and `package-lock.json` and every release link in `README.md`, `landing/index.html` and `landing/README.md`, then lists lines that still name the old version. Rewrite the ones that describe the release, leave the ones that are history, update `docs/PLAN.md`, and commit `release: prepare v0.1.6`.
2.  Merge to `main`, then `npm run release -- build 0.1.6`. It runs `npm run verify`, `npm run check:installers`, the landing checks, then packages. A proof build goes to `release/v0.1.6/proof/` and runs `proof:startup`, `proof:recovery` (twice, once with `--legacy`) and `proof:window-key`. The release build goes to `release/v0.1.6/`, with `Cockpit-0.1.6-arm64.dmg` and `SHA256SUMS` beside `mac-arm64/Cockpit.app`. It then mounts the DMG read-only, copies the app to an isolated folder and checks the version, the signature and that `app.asar` matches. It never writes to `release/mac-arm64/`, which may be the copy you are running. No provider usage. If the DMG size on the landing page changed, commit that line.
3.  `npm run release -- publish 0.1.6 --notes <file>` from a clean `main` equal to `origin/main`. It creates the GitHub prerelease with the DMG and `SHA256SUMS` and checks the uploaded asset's size and hash.
4.  `npm run release -- deploy 0.1.6` deploys `landing/` to Vercel, checks the live page and confirms the live update feed offers the new version.

Logs and screenshots go to `release/v<version>/evidence/` unless you pass `--evidence <dir>`.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on every pull request, on `macos-latest` with Node 22. It checks out, configures git for the repository tests, runs `npm ci`, `npm run check:paths`, `npm run typecheck`, `npm test`, `npm run build` and `npm run build:electron`. That equals `npm run verify`. It does not launch Electron, run packaged proofs, or run `check:installers`.

## Extending Cockpit

*   Verify adapter changes with protocol stand-ins first, such as `npm run proof:antigravity` or `npm run proof:opencode`, and with recorded traffic in `tests/fixtures/`.
*   A change to a settings schema needs the matching change to the allowlist that builds each CLI's flags.
*   Every `/api/threads` and `/api/git` route is listed in `server/remote/routes.ts` as allowed on the phone or not. A test fails on a route that is missing, so a new route is a decision.
*   The MCP tools are defined in `server/mcp/tools.ts`. User docs list them in the [guide](guide.md#what-agents-can-do-through-mcp).
