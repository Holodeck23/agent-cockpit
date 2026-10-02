# User Guide

This guide covers all user-facing features in Agent Cockpit, organized by task.

## Workspace & Projects

-   **Projects:** Select projects from the Projects menu. Cockpit remembers recent folders.
-   **Tabs:** Manage active files, previews, and documentation inside project tabs.
-   **Settings:** Access overarching settings for appearance and workflows.

## Agents & Settings

-   **Agent Selection:** You can switch the active agent for a conversation. If you switch mid-turn, Cockpit performs a handoff.
-   **Model & Effort:** Configure specific model usage (if left blank, Cockpit defaults to the CLI's default).
-   **Permissions:** You can control the level of autonomy the agent has, from full manual approval to more permissive setups.

## Conversations

-   **Starting:** Type a prompt in the composer to begin a new thread.
-   **Follow-ups:** Reply to ongoing threads or answer agent questions.
-   **Status States:** A conversation can be Working, Ready, Error, or "Needs you" (waiting for your approval or input).
-   **Stop vs. Complete vs. Delete:** You can Stop an active turn. You can mark a conversation complete. Deleting removes the thread permanently from your `~/.agent-cockpit/` history.
-   **Importing:** You can import existing agent sessions if supported by the adapter.

## Working with Files

-   **Documents & Editing:** Open **Files** to view, edit, and save text files in your project.
-   **Attachments:** Add files to your message draft via the composer's **+** menu. Text files are limited to 100 KB, with a max of 8 attachments and 200,000 characters per prompt.
-   **Conflicts:** Cockpit detects if a file was changed externally while you or the agent were editing it and provides conflict handling (e.g., Save mine as a copy).

## Git & Version Control

-   **Branches:** The composer features a branch pill showing your current Git branch. You can search, switch, or create-and-switch branches.
-   **Restrictions:** Switching branches waits until active agent turns finish.
-   **Dirty Changes:** Cockpit warns you if you have uncommitted changes. You must commit or stash them before switching branches.

## Processes & Previews

-   **Processes:** Agents can run commands (like `npm run dev`) scoped to the project.
-   **Previews:** Agents can open local web pages (localhost only) in the embedded preview pane and inspect screenshots of them.
-   **Controls:** You can manually restart, inspect logs, or stop processes from the UI. Cockpit cleans up processes when closing or stopping.

## Workflows & Schedules

-   **Gallery:** Open **Workflows** to access saved instructions and prompts.
-   **Schedules:** You can schedule workflows (e.g., run daily tests) by setting an interval (5 mins to 30 days) and clicking **Save and enable schedule**.
-   **Missed Runs:** If Cockpit is closed, at most one missed run is started when you reopen it.

## Memory & Scopes

-   **Scoping:** Each session is scoped tightly to its project directory.
-   **Approvals:** All mutating actions generally require your explicit approval unless explicitly configured otherwise.
-   **Memory:** Cockpit persists conversations as plain files in `~/.agent-cockpit/`. If memory files are malformed, Cockpit fails safely without overwriting recoverable data.

## Appearance & Sounds

-   Customize theme, sounds, and the activity view via settings.
-   Cockpit integrates with the macOS Dock to show active states.

## Phone Access

1.  Install **Tailscale** on your Mac and phone, signing in with the same account. Allow Tailscale network extensions.
2.  In Cockpit, open **Phone access** and click **Turn on phone access**.
3.  Scan the QR code or open the HTTPS address on your phone.
4.  Choose **Ask my Mac**, match the 6-digit code, and click **Allow** on the Mac.
5.  You can view conversations, answer approvals, and manage runs from your phone's browser. Push notification support is experimental.

## Agent-to-Agent MCP

Cockpit exposes a Model Context Protocol (MCP) server so agents can manage their own workspace.
-   **Available Now:** `list_conversations` and `read_conversation`. These are strictly bounded to the calling session's project and omit raw configuration/approval inputs.
-   **Note:** Mutating controls (start, message, stop) are currently being developed and are not yet available.
