# User Guide

> **v0.1.3 prerelease (2026-10-03).** Adds Check for Updates. This guide covers the updated tester build. Same-Mac acceptance passed on a second account for v0.1.2; independent human and other-Mac installation remain open. See the [tester checklist](tester-checklist.md).

This guide covers all user-facing features in Agent Cockpit, organized by task.

*(Documented for v0.1.3)*

## Workspace & Projects

-   **Toolbar Icons:** The main interface uses toolbar icons for quick access to core functions: **Projects** (folder icon), **Workflows** (play/gallery icon), **Files** (document icon), and **Settings** (gear icon).
-   **Projects:** Select projects from the Projects menu. Cockpit remembers recent folders. **New project…** asks for a name and a location in the standard macOS save panel, creates the folder and opens it; **Open folder…** opens one that already exists. New project never touches a folder that already has files.
-   **Tabs:** The top tabs switch projects, in the order you pinned them. Files and the embedded preview open inside the workspace.
-   **Shortcuts:** ⌘1–8 open the first eight tabs and ⌘9 the last one; ⌥⌘1–5 open Conversations, Files, Workflows, Memory and Processes. Hover a tab or section to see its shortcut.
-   **Window:** Cockpit reopens at the size and place you left it, as long as that place is still on a screen.
-   **Settings:** Access overarching settings for appearance and workflows.

## Agents & Settings

-   **Agent Selection:** You can switch the active agent for a conversation. Wait for the current turn to stop before switching. Cockpit hands the transcript to a fresh session with the selected agent.
-   **Model & Effort:** Configure specific model usage (if left blank, Cockpit defaults to the CLI's default). The effort button beside the agent changes effort in one click; in a conversation it applies from your next message and the agent's session continues.
-   **Remembered per agent:** Switching agents in the picker brings back what each agent was last set to on this Mac. Tick **Close after choosing an agent** to close the panel on a choice.
-   **Presets:** **Save these settings as a preset** names the current agent, model, effort and permissions; one click on the chip applies them later.
-   **Antigravity** starts in **Bypass permissions**, because it can't pause for approval when run by Cockpit. **Configured permissions** follows Antigravity's own settings; **Plan** is read-only.
-   **Permissions:** You can control the level of autonomy the agent has, from full manual approval to more permissive setups.

## Conversations

-   **Starting & Managing:** Type a prompt in the composer to begin a new thread. Use the conversation menu to mark complete, reopen, mark unread, reveal the transcript, or delete with confirmation. There is no duplicate/archive command.
-   **Follow-ups:** Reply to ongoing threads or answer agent questions.
-   **Status States:** A conversation can be Working, Ready, Error, or "Needs you" (waiting for your approval or input).
-   **Stop vs. Complete vs. Delete:** You can Stop an active turn. Note that stopping *requests* an interruption—it does not promise force-detaching the agent or stopping active dev servers immediately. You can mark a conversation complete when done. Deleting removes the thread permanently from your `~/.agent-cockpit/` history.
-   **Imports:** The Projects menu can import Claude Code and Codex sessions belonging to the selected folder; the next message resumes the original CLI session. Recent work now appears automatically when opening a project. It reuses an existing Cockpit conversation or imports the selected session, and treats branch/files as current disk state.

## Working with Files & Markdown

-   **Documents & Editing:** Open **Files** to view, edit, and save text files in your project. You can edit Markdown files in the dedicated Markdown Document view.
-   **Attachments:** Add files and workflows to your message draft via the composer's **+** menu, or type **@** in the message and pick from the list (↑↓, then Enter or Tab; Esc hides it). Text files are limited to 100 KB, with a max of 8 attachments and 200,000 characters per prompt. Note that attachments and prompt text are sent directly to the agent (provider-bound).
-   **Conflicts:** Cockpit detects if a file was changed externally while you or the agent were editing it and provides conflict handling (e.g., using **Reload from disk** or **Save mine as a copy**).

## Git & Version Control

-   **Branches:** The composer features a branch pill showing your current Git branch. You can search, switch, or create-and-switch branches.
-   **Restrictions:** Switching branches while an agent is busy is strictly refused (it is not queued for later).
-   **Dirty Changes:** Creating a *new* branch can carry uncommitted changes over, but switching to an *existing* branch requires you to commit or stash dirty changes first.

## Processes & Previews

-   **Processes:** Agents can run commands (like `npm run dev`) scoped to the project.
-   **Previews:** Agents can open local web pages (localhost only) in the embedded preview pane and inspect screenshots of them.
-   **Controls:** You can manually restart, inspect logs, or stop processes from the UI. Closing Cockpit shuts down its managed processes. Stopping or deleting a conversation leaves its dev servers running; stop those through the process controls.

## Workflows & Schedules

-   **Gallery & Editing:** Open **Workflows** to access saved instructions and prompts. You can edit existing workflows or pause them. Archiving a workflow hides it from normal views.
-   **Schedules:** You can schedule workflows (e.g., run daily tests) with an interval (5 minutes to 30 days), or at a daily, weekday, or selected-weekday time in the saved local timezone and clicking **Save and enable schedule**.
-   **Missed Runs & Failures:** If Cockpit is closed, at most one missed run is started when you reopen it. Workflows that fail will not block subsequent scheduled runs but will report errors in their thread.

## Memory & Scopes

-   **Scoping vs. Sandboxing:** Each session's MCP tools (like process runners) are scoped tightly to its project directory. However, this is *not* a strict filesystem sandbox for the provider—the underlying agent CLI still runs on your machine with your user permissions.
-   **Local State vs. Project Files:** Cockpit stores UI state, schedules, and active metadata internally (Local State). Actual project edits apply directly to your working directory (Project Files).
-   **Thread Recovery:** Cockpit persists your individual conversations as plain files in `~/.agent-cockpit/`. Conversation state and cross-thread memory are separate stores.
-   **`memory.json` Recovery:** Cockpit maintains a separate `memory.json` (Project/Everywhere memory) for cross-thread context. If this file is malformed, Cockpit preserves its bytes and refuses memory reads and writes. Back it up and repair it deliberately; the app does not silently reset it or claim automatic recovery.
-   **Memory Controls:** Use the Memory view to edit Project or Everywhere entries. Project Instructions is a separate setting.

## Appearance & Sounds

-   Customize theme, sounds, and the activity view via settings.
-   Cockpit integrates with the macOS Dock to show active states. The Dock icon follows Cockpit's appearance, with a dark version in Dark.
-   A project's colour (Project settings) tints its tab, the send and primary buttons, the working and process badges, the Complete control and resize bars.

## Phone Access

1.  Install **Tailscale** on your Mac and phone, signing in with the same account. Allow Tailscale network extensions.
2.  In Cockpit, open **Phone access** and click **Turn on phone access**.
3.  Scan the QR code or open the HTTPS address on your phone.
4.  Choose **Ask my Mac**, match the 6-digit code, and click **Allow** on the Mac.
5.  You can view conversations, answer approvals, and manage runs from your phone's browser.
6.  **Revocation:** You can revoke phone access or disable Cockpit’s phone access from the Phone Access panel on your Mac.
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
-   **Feature branch M2:** `start_conversation`, `send_to_conversation`, and `stop_conversation` are implemented with a separate Allow/Deny card per action. They are restricted to the calling project, refuse self/foreign targets and recursive delegation, and use durable request keys to suppress duplicates. They are included in v0.1.1; the older September 30 v0.1.0 DMG does not have them.

## Updates

-   **Check for Updates…** is in the Cockpit app menu (v0.1.3 and later). It reads the official GitHub release list, including prereleases, and only checks when you choose it.
-   **Download Update** opens the official Apple-silicon DMG for that release in your browser. Install it by hand: finish or stop running agents, quit Cockpit, open the DMG and drag Cockpit to Applications to replace the old copy. State in `~/.agent-cockpit/` is outside the app, so conversations and settings are kept.
-   If the check fails (offline, rate-limited, or the newest release has no installer yet), Cockpit says so; a failed check never reports "up to date". When GitHub can't be reached, **Troubleshooting** opens the network section of the troubleshooting guide.
-   After you install a newer version, Cockpit says **Updated to Cockpit x** once; **What's new** shows that version's notes.

## Help

-   **Help → Release Notes** shows what changed in the version you're running, inside Cockpit. Notes come from the same GitHub release list as Check for Updates and are shown as plain text.
-   **Help → Cockpit Guide** and **Troubleshooting** open these pages in your browser.
-   **Help → Report a Problem…** opens a new GitHub issue with only your Cockpit and macOS versions filled in. Nothing else is sent; add what happened yourself.
-   Errors that look like a network problem (an agent that can't reach its provider, a failed update check) link to [Network problems](troubleshooting.md#network-problems).

## Data, Backup, and Privacy

-   **Data Location:** Cockpit state lives in `~/.agent-cockpit/` unless `COCKPIT_HOME` overrides it. Project files and the CLIs’ own credentials/session stores live separately.
-   **Privacy:** Cockpit does not send telemetry to a central server. Check for Updates, when you choose it, requests the public release list from GitHub's API (no account or project data is sent). Agent runs can send prompts, attachments and project content to the configured provider, including scheduled workflow runs. Tools may also contact external services. Optional push notifications are sent via standard Web Push infrastructure if enabled on your phone.
-   **Backups:** To back up your Cockpit data, securely copy the `~/.agent-cockpit/` directory.

## Extension Notes for Developers

If you want to extend Cockpit or develop new tools for it:
-   Verify adapter integrations locally using protocol stand-ins (e.g. `npm run proof:antigravity`).
-   Keep in mind that modifications to schemas require corresponding updates to the allowlists.
-   Consult the [Developer Guide](developer.md) for architecture, packaging, and testing specifics.
