# Developer Guide

> **v0.1.3 prerelease (2026-10-03).** Adds Check for Updates. This guide covers the updated tester build. Same-Mac acceptance passed on a second account for v0.1.2; independent human and other-Mac installation remain open. See the [tester checklist](tester-checklist.md).

This guide is for developers looking to build, test, and package Agent Cockpit locally.

## Architecture Overview

Cockpit operates with a local server architecture running entirely on your machine.

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

-   **Adapters:** These translate each specific CLI's wire protocol (e.g., Claude's stream-json, Codex's JSON-RPC) into a unified event model.
-   **Security:** CLI settings are validated. Approved process commands run in a shell, and provider tools retain the filesystem access allowed by their CLI policy.
-   **Server:** The local UI routes check host and origin. MCP routes use session-scoped tokens; the optional phone listener authenticates paired devices. The desktop application packages this same server into an Electron main process.
-   **State Storage:** Threads, workflows, and configuration are stored as plain files in `~/.agent-cockpit/`.

## Local Development & Build Commands

Ensure you have Node.js and `npm` installed. Run `npm ci` in the repository first. The published-source license requires written permission to modify or redistribute; see [LICENSE](../../LICENSE).

| Command | Description |
| :--- | :--- |
| `npm run doctor` | Checks the supported platform, installed agent CLIs, and Tailscale (does not test account authentication). |
| `npm run verify` | Runs TypeScript type checking, unit tests, Vite web build, and Electron build. |
| `npm start` | Starts the backend on port 4317 by default (`COCKPIT_PORT` overrides it). Run `npm run build` and `npm run build:electron` first for the UI and MCP bundle. |
| `npm run dev:server` | Starts the backend server with hot-reload via `tsx watch`. |
| `npm run dev:web` | Starts the Vite dev server for the React frontend. |
| `npm run app` | Builds the project and opens the Electron desktop app locally. |
| `npm run package` | Builds the production `Cockpit.app` and a `.dmg` installer for macOS arm64 at `release/mac-arm64/Cockpit.app` and `release/Cockpit-0.1.3-arm64.dmg`. |

## Testing and Proofs

Testing is separated into isolated packaged proofs (using Playwright against the packaged Electron app) and live-provider smoke tests.

**Packaged Proofs (No API Cost):**
These tests verify UI and application logic against protocol stand-ins and local files without consuming live API usage limits.
*   `npm run proof:reliability`
*   `npm run proof:director` (First-run path verification)
*   *See `package.json` for the full list of `proof:*` commands.*

**Packaged Proofs (Consumes API Allowance):**
These tests use real providers (even if checking synthetic local data) and will consume your configured API allowance. Do not run paid proofs during general documentation tasks.
*   `npm run proof:app`
*   `npm run proof:workflows`
*   `npm run proof:files` (Pass `--codex` to run with Codex instead of Claude)
*   `npm run proof:mcp` (Pass `--codex` to run with Codex)

**Live Smokes (Consumes API Allowance):**
These tests perform real multi-turn runs that resume across processes, consuming actual provider usage.
*   `npm run smoke:claude`
*   `npm run smoke:codex` (Set `COCKPIT_CODEX_MODEL` to choose an available model for your account).
*   `npm run smoke:antigravity`
*   `npm run smoke:mcp [claude|codex]`

*Note: The packaged file/process checks use Codex's configured model or default development model. Always verify your account limits before running live or paid proofs.*

## Releasing

Releases are Apple-silicon prereleases on GitHub, announced by the landing page and offered by **Check for Updates**. `scripts/release.ts` runs them in four stages. Each stage checks its own preconditions, so a failed stage can be re-run on its own.

1. `npm run release -- prepare 0.1.4` on the branch being released: bumps `package.json`/`package-lock.json` and every release link in the README and landing page, then lists lines that still name the old version. Rewrite those that describe the release, leave those that are history ("v0.1.3 and later include…"), then commit `release: prepare v0.1.4`.
2. Merge to `main`, then `npm run release -- build 0.1.4`: `verify`, the landing checks, packaging into `release/v0.1.4/` (never `release/mac-arm64/`, which may be the copy you are running), `SHA256SUMS`, an install from a read-only mount into an isolated folder (version, signature, `app.asar` match) and the startup and recovery proofs on that installed copy. No provider usage. If the DMG size on the landing page changed, commit that line.
3. `npm run release -- publish 0.1.4 --notes <file>` from a clean `main` equal to `origin/main`: creates the GitHub prerelease with the DMG and `SHA256SUMS` and checks the uploaded asset's size and digest.
4. `npm run release -- deploy 0.1.4`: deploys `landing/` to Vercel, checks the live page and confirms the live update feed offers the new version.

Logs and screenshots go to `release/v<version>/evidence/` unless `--evidence <dir>` is given.
