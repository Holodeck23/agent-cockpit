# User Guide

This guide covers all user-facing features in Agent Cockpit, organized by task.

*(Documented against source revision `654cbd0`)*

## Workspace & Projects

-   **Toolbar Icons:** The main interface uses toolbar icons for quick access to core functions: **Projects** (folder icon), **Workflows** (play/gallery icon), **Files** (document icon), and **Settings** (gear icon).
-   **Projects:** Select projects from the Projects menu. Cockpit remembers recent folders.
-   **Tabs:** Manage active files, previews, and documentation inside project tabs.
-   **Settings:** Access overarching settings for appearance and workflows.

## Agents & Settings

-   **Agent Selection:** You can switch the active agent for a conversation. If you switch mid-turn, Cockpit performs a handoff, but you must first wait for the current agent to stop.
-   **Model & Effort:** Configure specific model usage (if left blank, Cockpit defaults to the CLI's default).
-   **Permissions:** You can control the level of autonomy the agent has, from full manual approval to more permissive setups.

## Conversations

-   **Starting & Managing:** Type a prompt in the composer to begin a new thread. Use the conversation menu to rename, archive, or duplicate threads.
-   **Follow-ups:** Reply to ongoing threads or answer agent questions.
-   **Status States:** A conversation can be Working, Ready, Error, or "Needs you" (waiting for your approval or input).
-   **Stop vs. Complete vs. Delete:** You can Stop an active turn. Note that stopping *requests* an interruption—it does not promise force-detaching the agent or stopping active dev servers immediately. You can mark a conversation complete when done. Deleting removes the thread permanently from your `~/.agent-cockpit/` history.
-   **Imports:** Cockpit allows you to import existing agent sessions if supported by the adapter. This is separate from normal conversation recovery.

## Working with Files & Markdown

-   **Documents & Editing:** Open **Files** to view, edit, and save text files in your project. You can edit Markdown files in the dedicated Markdown Document view.
-   **Attachments:** Add files to your message draft via the composer's **+** menu. Text files are limited to 100 KB, with a max of 8 attachments and 200,000 characters per prompt. Note that attachments and prompt text are sent directly to the agent (provider-bound).
-   **Conflicts:** Cockpit detects if a file was changed externally while you or the agent were editing it and provides conflict handling (e.g., using **Reload from disk** or **Save mine as a copy**).

## Git & Version Control

-   **Branches:** The composer features a branch pill showing your current Git branch. You can search, switch, or create-and-switch branches.
-   **Restrictions:** Switching branches while an agent is busy is strictly refused (it is not queued for later).
-   **Dirty Changes:** Creating a *new* branch can carry uncommitted changes over, but switching to an *existing* branch requires you to commit or stash dirty changes first.

## Processes & Previews

-   **Processes:** Agents can run commands (like `npm run dev`) scoped to the project.
-   **Previews:** Agents can open local web pages (localhost only) in the embedded preview pane and inspect screenshots of them.
-   **Controls:** You can manually restart, inspect logs, or stop processes from the UI. Cockpit cleans up processes when closing or stopping.

## Workflows & Schedules

-   **Gallery & Editing:** Open **Workflows** to access saved instructions and prompts. You can edit existing workflows or pause them. Archiving a workflow hides it from normal views.
-   **Schedules:** You can schedule workflows (e.g., run daily tests) by setting an interval (5 mins to 30 days) and clicking **Save and enable schedule**.
-   **Missed Runs & Failures:** If Cockpit is closed, at most one missed run is started when you reopen it. Workflows that fail will not block subsequent scheduled runs but will report errors in their thread.

## Memory & Scopes

-   **Scoping vs. Sandboxing:** Each session's MCP tools (like process runners) are scoped tightly to its project directory. However, this is *not* a strict filesystem sandbox for the provider—the underlying agent CLI still runs on your machine with your user permissions.
-   **Local State vs. Project Files:** Cockpit stores UI state, schedules, and active metadata internally (Local State). Actual project edits apply directly to your working directory (Project Files).
-   **Thread Recovery:** Cockpit persists your individual conversations as plain files in `~/.agent-cockpit/`. If memory files are malformed, Cockpit fails safely without overwriting recoverable data.
-   **`memory.json` Recovery:** Cockpit maintains a separate `memory.json` (Project/Everywhere memory) for cross-thread context. If `memory.json` becomes corrupted, Cockpit can recover gracefully without breaking individual threads.
-   **Memory Controls:** You can view and explicitly edit the gathered memory instructions for a project via the Project Instructions settings.

## Appearance & Sounds

-   Customize theme, sounds, and the activity view via settings.
-   Cockpit integrates with the macOS Dock to show active states.

## Phone Access

1.  Install **Tailscale** on your Mac and phone, signing in with the same account. Allow Tailscale network extensions.
2.  In Cockpit, open **Phone access** and click **Turn on phone access**.
3.  Scan the QR code or open the HTTPS address on your phone.
4.  Choose **Ask my Mac**, match the 6-digit code, and click **Allow** on the Mac.
5.  You can view conversations, answer approvals, and manage runs from your phone's browser.
6.  **Revocation:** You can revoke phone access or stop the Tailscale service entirely from the Phone Access panel on your Mac.
7.  **Push Notifications (Experimental):** Notifications are an optional transmission. They require explicit browser notification permission on your phone. You can manage notification settings directly from the phone UI.

## Agent-to-Agent MCP

Cockpit exposes a Model Context Protocol (MCP) server so agents can manage their own workspace.
-   **Available Now:**
    -   `list_conversations`: Lists conversations within the calling project.
    -   `read_conversation`: Reads a specific conversation within the calling project.
    -   `start_process`: Runs a command such as `npm run dev` in the project and waits for its URL or first output (Asks first).
    -   `stop_process`: Stops it and everything it spawned (Asks first).
    -   `list_processes`: The project's processes, status and URL.
    -   `read_process_output`: The log, incrementally.
    -   `open_preview`: Opens a local page (localhost only) in the preview pane.
    -   `inspect_preview`: Returns a screenshot of the local page to the agent.
    -   `save_workflow`: Saves reusable instructions in the current project, with scheduling off (Asks first).
-   **Note:** Mutating agent-to-agent controls (start, message, stop) are currently being developed (Checkpoint M2) and are not yet available in this release.

## Data, Backup, and Privacy

-   **Data Location:** All your Cockpit configuration, workflows, and conversation history are stored locally in `~/.agent-cockpit/`.
-   **Privacy:** Cockpit does not send telemetry to a central server. Your data is only transmitted to the configured AI provider when you actively run a thread. Optional push notifications are sent via standard Web Push infrastructure if enabled on your phone.
-   **Backups:** To back up your Cockpit data, securely copy the `~/.agent-cockpit/` directory.

## Extension Notes for Developers

If you want to extend Cockpit or develop new tools for it:
-   Verify adapter integrations locally using protocol stand-ins (e.g. `npm run proof:antigravity`).
-   Keep in mind that modifications to schemas require corresponding updates to the allowlists.
-   Consult the [Developer Guide](developer.md) for architecture, packaging, and testing specifics.
