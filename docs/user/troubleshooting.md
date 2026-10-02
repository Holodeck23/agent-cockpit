# Troubleshooting

> **v0.1.1 prerelease (2026-10-02).** This guide covers the updated tester build. Second-person installation acceptance is pending; see the [tester checklist](tester-checklist.md).

When issues occur, Cockpit is designed to fail safely and preserve your work.

**Important Data Safety Note:** Before attempting any recovery step that involves files (like deleting state or config), always copy the relevant folder (e.g., `~/.agent-cockpit/`) to a safe location first. Never recommend deleting unique work, clearing credentials, or bypassing macOS permissions as a casual fix.

## Agents & Launch Issues

**Symptom:** "Claude Code isn't installed or isn't on PATH…" error message when starting a thread.
*   **Likely Cause:** The agent CLI is installed in a directory that is not exposed to desktop applications. Apps launched from the macOS Finder do not inherit your terminal's custom PATH modifications (like `~/.nvm`, Homebrew, etc.).
*   **Recovery:** Cockpit already resolves your login-shell PATH plus common installation folders. In Terminal, check `command -v claude` (or your agent executable), then verify the CLI itself works. Quit and reopen Cockpit after fixing the installation; do not relocate or reinstall a working CLI merely because detection failed.

**Symptom:** Agent starts but immediately fails with authentication errors.
*   **Likely Cause:** You are not logged into the agent's provider, or your session expired.
*   **Recovery:** Open your standard terminal and run the agent CLI directly (e.g., `claude`). Complete the login flow there, ensure it works, and then retry your request in Cockpit.

**Symptom:** Agent immediately stops working and reports quota or billing errors.
*   **Likely Cause:** You have hit the rate limit or billing cap for that provider.
*   **Recovery:** Cockpit will display the limit error. You can use the agent selector in Cockpit to switch to a different configured agent and resume the conversation.

**Symptom:** Cockpit opens, but expected new features are missing, or the UI looks wrong.
*   **Likely Cause:** You might be launching a stale build (e.g., an older `.dmg` in your Downloads folder) instead of the updated version in `/Applications`.
*   **Recovery:** Right-click the app icon in the Dock or Finder, select **Options > Show in Finder**, and verify it is the `/Applications/Cockpit.app` copy. Compare the release date and source revision; a version number alone cannot identify which features are present. Keep older copies clearly labelled if you need them.

**Symptom:** Codex says the configured model requires a newer CLI.
* **Cause:** The CLI executable Cockpit found is older than the model configured in your Codex settings. Detection alone does not prove model compatibility.
* **Recovery:** Update Codex using the same method you installed it with (for a Homebrew cask: `brew upgrade --cask codex`), verify the CLI works in Terminal, then reopen Cockpit. Or choose another installed, authenticated agent. Cockpit does not change provider configuration automatically.

## Conversations & Workflows

**Symptom:** A conversation is stuck in a "Working" state but the agent is no longer responding.
*   **Likely Cause:** The underlying agent process crashed or was interrupted abruptly without sending a clean exit signal.
*   **Recovery:** Click the **Stop** button on the conversation turn. This requests interruption. Wait for a terminal status before following up. It does not stop the conversation’s dev servers. If it remains stuck, preserve the logs and report the failure.

**Symptom:** You receive a malformed memory error.
*   **Likely Cause:** `memory.json`, the cross-thread memory store, is unreadable or malformed. This is distinct from an individual conversation failing to load.
*   **Recovery:** Cockpit is designed to fail safely and will not overwrite corrupted data. Back up the `~/.agent-cockpit/` folder. Repair or restore `memory.json` from a known-good backup before attempting memory changes. For an individual conversation problem, preserve its metadata, event log and transcript separately.

**Symptom:** An agent is waiting indefinitely on an approval prompt, but you don't see one.
*   **Likely Cause:** The approval prompt might be buried in the chat history, or the UI state desynced.
*   **Recovery:** Scroll to the bottom of the conversation thread. If no prompt is visible, reload the Cockpit window (using `Cmd+R` or the View menu) to refresh the UI state.

## Files & Previews

**Symptom:** Cockpit warns about a file conflict when saving an edit.
*   **Likely Cause:** You edited a file inside Cockpit, but that same file was modified by an external editor (or Git) before you saved.
*   **Recovery:** Review the changes. Choose **Save mine as a copy** to preserve your edits to a new file, or **Revert** to load the external changes.

**Symptom:** "Dev-server/port already in use" error when starting a process.
*   **Likely Cause:** A previous development server was not shut down cleanly, or you started it outside of Cockpit.
*   **Recovery:** Read Cockpit’s process list and logs first. Reuse a healthy server or stop only the managed process you recognize. If another application owns the port, choose another port or identify its owner before stopping anything.

**Symptom:** The embedded preview pane fails to load the application.
*   **Likely Cause:** The dev server hasn't finished booting yet, or it bound to a host other than `localhost`/`127.0.0.1`.
*   **Recovery:** Check the process log in Cockpit to verify the server is fully started. Ensure the application is configured to serve on `localhost`. Click the reload button on the preview pane.

## Phone Access

**Symptom:** Scanning the QR code on the phone fails to load the page.
*   **Likely Cause:** Your phone and Mac are not connected to the same Tailscale network, or MagicDNS is not resolving.
*   **Recovery:** Verify Tailscale is running on both devices and logged into the same account. Ensure the Mac is awake. Check the Tailscale admin console that HTTPS certificates are enabled.

**Symptom:** The phone loads the page, but pairing is refused.
*   **Likely Cause:** The 6-digit code was not matched, or you rejected the prompt on the Mac.
*   **Recovery:** Close the browser tab on your phone. Go to Cockpit's Phone Access settings on the Mac, check that phone access is enabled, then repeat **Ask my Mac** and compare the new code.
