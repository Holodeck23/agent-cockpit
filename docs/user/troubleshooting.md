# Troubleshooting

When issues occur, Cockpit is designed to fail safely and preserve your work.

**Important Data Safety Note:** Before attempting any recovery step that involves files (like deleting state or config), always copy the relevant folder (e.g., `~/.agent-cockpit/`) to a safe location first. Never recommend deleting unique work, clearing credentials, or bypassing macOS permissions as a casual fix.

## Agents & Launch Issues

**Symptom:** "Claude Code isn't installed or isn't on PATH…" error message when starting a thread.
*   **Likely Cause:** The agent CLI is installed in a directory that is not exposed to desktop applications. Apps launched from the macOS Finder do not inherit your terminal's custom PATH modifications (like `~/.nvm`, Homebrew, etc.).
*   **Recovery:** Ensure the CLI is installed in a standard global location (like `/usr/local/bin`), or launch Cockpit from the terminal (`open /Applications/Cockpit.app`) so it inherits your shell environment.

**Symptom:** Agent starts but immediately fails with authentication errors.
*   **Likely Cause:** You are not logged into the agent's provider, or your session expired.
*   **Recovery:** Open your standard terminal and run the agent CLI directly (e.g., `claude`). Complete the login flow there, ensure it works, and then retry your request in Cockpit.

**Symptom:** Agent immediately stops working and reports quota or billing errors.
*   **Likely Cause:** You have hit the rate limit or billing cap for that provider.
*   **Recovery:** Cockpit will display the limit error. You can use the agent selector in Cockpit to switch to a different configured agent and resume the conversation.

**Symptom:** Cockpit opens, but expected new features are missing, or the UI looks wrong.
*   **Likely Cause:** You might be launching a stale build (e.g., an older `.dmg` in your Downloads folder) instead of the updated version in `/Applications`.
*   **Recovery:** Right-click the app icon in the Dock or Finder, select **Options > Show in Finder**, and verify it is the `/Applications/Cockpit.app` copy. Delete stale downloads.

## Conversations & Workflows

**Symptom:** A conversation is stuck in a "Working" state but the agent is no longer responding.
*   **Likely Cause:** The underlying agent process crashed or was interrupted abruptly without sending a clean exit signal.
*   **Recovery:** Click the **Stop** button on the conversation turn. This will force Cockpit to detach from the hung process. You can then write a follow-up to resume the task.

**Symptom:** You receive a malformed memory error, or a conversation refuses to load.
*   **Likely Cause:** The conversation file stored in `~/.agent-cockpit/` was corrupted or written incorrectly by a crashed process.
*   **Recovery:** Cockpit is designed to fail safely and will not overwrite corrupted data. Back up the `~/.agent-cockpit/` folder. You can open the raw text file for that specific thread in a standard text editor to recover your written prompts.

**Symptom:** An agent is waiting indefinitely on an approval prompt, but you don't see one.
*   **Likely Cause:** The approval prompt might be buried in the chat history, or the UI state desynced.
*   **Recovery:** Scroll to the bottom of the conversation thread. If no prompt is visible, reload the Cockpit window (using `Cmd+R` or the View menu) to refresh the UI state.

## Files & Previews

**Symptom:** Cockpit warns about a file conflict when saving an edit.
*   **Likely Cause:** You edited a file inside Cockpit, but that same file was modified by an external editor (or Git) before you saved.
*   **Recovery:** Review the changes. Choose **Save mine as a copy** to preserve your edits to a new file, or **Revert** to load the external changes.

**Symptom:** "Dev-server/port already in use" error when starting a process.
*   **Likely Cause:** A previous development server was not shut down cleanly, or you started it outside of Cockpit.
*   **Recovery:** Use Cockpit's process controls to stop the existing running process, or find and kill the process manually in your terminal (`lsof -i :<port>`), then click Restart in Cockpit.

**Symptom:** The embedded preview pane fails to load the application.
*   **Likely Cause:** The dev server hasn't finished booting yet, or it bound to a host other than `localhost`/`127.0.0.1`.
*   **Recovery:** Check the process log in Cockpit to verify the server is fully started. Ensure the application is configured to serve on `localhost`. Click the reload button on the preview pane.

## Phone Access

**Symptom:** Scanning the QR code on the phone fails to load the page.
*   **Likely Cause:** Your phone and Mac are not connected to the same Tailscale network, or MagicDNS is not resolving.
*   **Recovery:** Verify Tailscale is running on both devices and logged into the same account. Ensure the Mac is awake. Check the Tailscale admin console that HTTPS certificates are enabled.

**Symptom:** The phone loads the page, but pairing is refused.
*   **Likely Cause:** The 6-digit code was not matched, or you rejected the prompt on the Mac.
*   **Recovery:** Close the browser tab on your phone. Go to Cockpit's Phone Access settings on the Mac, click "Turn on phone access" again, and repeat the pairing process carefully.
