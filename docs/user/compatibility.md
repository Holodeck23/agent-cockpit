# Agent Compatibility and Limitations

> **v0.1.1 prerelease (2026-10-02).** This guide covers the updated tester build. Second-person installation acceptance is pending; see the [tester checklist](tester-checklist.md).

Agent Cockpit provides a unified interface across different AI coding agents. However, each agent has specific requirements, capabilities, and limitations based on its CLI implementation and API provider.

## Supported Agents Matrix

| Agent | Source/CLI | Verification Status | Notes |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `@anthropic-ai/claude-code` | Live resume smokes and selected packaged proofs passed | Supports full process control, file editing, and process previews. Real API usage is bounded by Anthropic's rate limits. |
| **Codex** | Codex App Server | Live resume smokes and selected packaged proofs passed | Supports full process control, workflow schedules, and file attachments. Tested heavily in the main release flow. |
| **Google Antigravity** | `agy` CLI | Live subscription resume and packaged fixture passed | Requires proper Google credentials setup. Has specific MCP connection limitations (see below). |
| **OpenCode** | OpenCode CLI | Packaged ACP stand-in passed; live OpenRouter untested | Primary method for connecting to OpenRouter models via the Agent Client Protocol (ACP). |

## Important Distinctions

*   **Google Antigravity vs. Standalone Gemini:** Cockpit integrates specifically with the Google Antigravity (`agy`) CLI, which is distinct from standalone Gemini CLI tools. Ensure you are using the correct `agy` executable.
*   **OpenCode vs. OpenRouter:** Cockpit does not connect to OpenRouter directly. Instead, you configure the OpenCode CLI with your OpenRouter keys, and Cockpit communicates with OpenCode.
*   **Detection vs. Authentication:** Cockpit detects an installed CLI by finding its executable on your `PATH`. *Detecting* the CLI does not mean it is authenticated. You must successfully log into the provider using the CLI directly (e.g., in your terminal) to ensure you have valid credentials and available quota before Cockpit can run tasks.
*   **Implementation vs. Live Verification:** Some features (like the adapter wiring) are verified against local protocol stand-ins (mocks) during development. Full live-provider behavior depends entirely on the remote API's uptime, speed, and your account limits.

## Known Agent Limitations

### Google Antigravity
*   **Headless Permissions:** Antigravity manages its own headless permissions internally. When run via Cockpit, workspace edits can proceed under the default or manual policy, but shell actions that would normally need approval are strictly denied. There are no host approval cards displayed in Cockpit for Antigravity, and no Cockpit MCP tools are injected into its context.
*   **Per-Launch MCP:** Because Antigravity has no per-launch Cockpit MCP connection capability, it cannot be used for the first-run 90-second sample project (which relies heavily on MCP tool integration for process previews).

### Phone Approvals and Notifications
*   **Push Notifications:** While the Web Push infrastructure is implemented in Cockpit, delivery to a physical phone remains an uncompleted manual acceptance check (requiring Tailscale). Push notifications must be explicitly granted on the phone, and acceptance of the notification payload by the device is subject to the phone's OS rules.
