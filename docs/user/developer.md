# Developer Guide

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
-   **Security:** Nothing raw reaches a command line. Every flag passed to a CLI is built from a strict schema allowlist.
-   **Server:** The internal server only answers to its own page (loopback host, matching origin) to ensure web pages open in your external browser cannot drive your local agents. The desktop application packages this same server into an Electron main process.
-   **State Storage:** Threads, workflows, and configuration are stored as plain files in `~/.agent-cockpit/`.

## Local Development & Build Commands

Ensure you have Node.js and `npm` installed.

| Command | Description |
| :--- | :--- |
| `npm run doctor` | Checks the supported platform, installed agent CLIs, and Tailscale (does not test account authentication). |
| `npm run verify` | Runs TypeScript type checking, unit tests, Vite web build, and Electron build. |
| `npm start` | Starts the backend server and serves the UI at `http://127.0.0.1:4317`. |
| `npm run dev:server` | Starts the backend server with hot-reload via `tsx watch`. |
| `npm run dev:web` | Starts the Vite dev server for the React frontend. |
| `npm run app` | Builds the project and opens the Electron desktop app locally. |
| `npm run package` | Builds the production `Cockpit.app` and a `.dmg` installer for macOS arm64 inside `release/mac-arm64/`. |

## Testing and Proofs

Testing is separated into isolated packaged proofs (using Playwright against the packaged Electron app) and live-provider smoke tests.

**Packaged Proofs (No API Cost):**
These tests verify UI and application logic against protocol stand-ins and local files without consuming live API usage limits.
*   `npm run proof:app`
*   `npm run proof:reliability`
*   `npm run proof:workflows`
*   `npm run proof:files` (Pass `--codex` to run with Codex instead of Claude)
*   `npm run proof:mcp` (Pass `--codex` to run with Codex)
*   `npm run proof:director` (First-run path verification)
*   *See `package.json` for the full list of `proof:*` commands.*

**Live Smokes (Consumes API Allowance):**
These tests perform real multi-turn runs that resume across processes, consuming actual provider usage.
*   `npm run smoke:claude`
*   `npm run smoke:codex` (Set `COCKPIT_CODEX_MODEL` to choose an available model for your account).
*   `npm run smoke:antigravity`
*   `npm run smoke:mcp [claude|codex]`

*Note: The packaged file/process checks use Codex's configured model or default development model. Always verify your account limits before running live smokes.*
