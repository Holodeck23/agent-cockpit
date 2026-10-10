# User Guide

> **v0.1.7 prerelease.** This guide describes Cockpit 0.1.7: worktrees, account profiles, the handoff review before switching agents, phone live preview, Feedback, the Terminal install and the beta terms are all covered below. Independent other-Mac acceptance of this version is still open; see the [tester checklist](tester-checklist.md).

This guide covers all user-facing features in Agent Cockpit, organized by task.

## Workspace & Projects

-   **Toolbar Icons:** The main interface uses toolbar icons for quick access to core functions: **Projects** (folder icon), **Workflows** (play/gallery icon), **Files** (document icon), and **Settings** (gear icon).
-   **Projects:** Select projects from the Projects menu. Cockpit remembers recent folders. **New project…** asks for a name and a location in the standard macOS save panel, creates the folder and opens it; **Open folder…** opens one that already exists. New project never touches a folder that already has files.
-   **Tabs:** The top tabs switch projects, in the order you pinned them. Files and the embedded preview open inside the workspace.
-   **Shortcuts:** ⌘1–8 open the first eight tabs and ⌘9 the last one; ⌥⌘1–5 open Conversations, Files, Workflows, Memory and Processes. Hover a tab or section to see its shortcut.
-   **Window:** Cockpit reopens at the size and place you left it, as long as that place is still on a screen.
-   **Removing a project:** hover a project in the Projects menu and click the bin to remove it from Cockpit. Its folder and conversations stay; schedules in it are paused. Opening the folder again brings it back.
-   **Pins in the navigation:** pin a project file or one of Your documents (**⋯ → Pin to navigation**) and it appears beside the sections, so you can reopen it from anywhere.
-   **Settings:** Access overarching settings for appearance and workflows.

## Agents & Settings

-   **Agent Selection:** You can switch the active agent for a conversation. Wait for the current turn to stop before switching. Cockpit hands the transcript to a fresh session with the selected agent.
-   **Model & Effort:** Configure specific model usage (if left blank, Cockpit defaults to the CLI's default). The effort button beside the agent changes effort in one click; in a conversation it applies from your next message and the agent's session continues.
-   **Remembered per agent:** Switching agents in the picker brings back what each agent was last set to on this Mac. Tick **Close after choosing an agent** to close the panel on a choice.
-   **Presets:** **Save these settings as a preset** names the current agent, model, effort and permissions; one click on the chip applies them later.
-   **Antigravity** starts in **Bypass permissions**, because it can't pause for approval when run by Cockpit. **Configured permissions** follows Antigravity's own settings; **Plan** is read-only.
-   **Permissions:** You can control the level of autonomy the agent has, from full manual approval to more permissive setups.

### Switching agents

1.  In a conversation, open the agent picker, choose another agent and press **Switch…**. Stop the current turn first.
2.  Cockpit shows **What <agent> receives**: the exact text the new agent will get, its size, and whether it is the whole conversation or how many earlier messages were left out to fit (the budget is 400,000 characters; the opening request and the newest messages are kept, never half a message).
3.  Press **Start handoff** to switch, or **Back** to leave things as they are.

The handoff is a short briefing plus the transcript so far: your messages, the replies, a note for each tool used, questions and your answers, and any image named by file. A message you took back is not in it. The new agent starts a fresh session; provider-side history is not transferred. If the conversation changes after you open the review, **Start handoff** is refused with "The conversation changed since you reviewed the handoff. Review it again before switching.", so an agent only ever receives what you saw.

### Accounts

A project can run Claude Code or Codex on an account other than your CLI's default login.

-   In the agent picker (or **Project settings**), the **Account** menu shows the CLI default and any account profiles. **Add an account…** asks for a name, then runs that CLI's own sign-in in a separate folder under `~/.agent-cockpit/`. Your default login is never signed out or changed.
-   The choice is per project and per agent: every conversation on that agent in the project uses it from its next turn. A running conversation keeps the account it started with until it is idle.
-   Providers cannot resume a session under another account, so continuing a conversation after a switch starts a fresh session with a handoff (as above), and the transcript says so.
-   Antigravity and OpenCode use their CLI default only; Cockpit says why in the menu.

## Conversations

-   **Starting & Managing:** Type a prompt in the composer to begin a new thread. Use the conversation menu to mark complete, reopen, mark unread, reveal the transcript, or delete with confirmation. There is no duplicate/archive command.
-   **Follow-ups:** Reply to ongoing threads or answer agent questions.
-   **Replies:** Agent replies show as formatted text: headings, lists, tables, code. Web links open in your browser; hover one to see where it goes, and a link whose text names a different site than it goes to shows the real one beside it (↗ host). Raw HTML in a reply shows as text and images are never loaded (you see their description). Your own messages stay exactly as you typed them.
-   **File and commit links:** `src/app.ts:42` in a reply opens Files with that line selected (ranges like `:10-20` too). A commit hash opens the commit on GitHub, GitLab or Bitbucket when the project's `origin` is there; otherwise it copies the hash. Agents are asked to name their commits by short hash.
-   **Find:** ⌘F highlights matches in the open conversation and lists the matching messages under the bar; click one to jump to it.
-   **Reading while it works:** the conversation stays where you are reading while the agent writes; **Jump to latest** brings you back to the end. **Copy** on a message puts its text on the clipboard. The conversation list can be resized by dragging its edge.
-   **Mac notifications:** Cockpit notifies you when an agent finishes or needs you, and clicking the notification opens that conversation. The conversation you are looking at makes no sound and shows no banner. A completed conversation never counts as needing you.
-   **Dismiss:** a question from the agent can be dismissed without answering; the agent carries on without the answers.
-   **Search:** The list's search looks through every message, not just titles, and includes completed conversations while you search.
-   **Peek:** Hover a file or workflow clip on a sent message to see inside it; **Open in Files** opens the file.
-   **Status States:** A conversation can be Working, Ready, Error, or "Needs you" (waiting for your approval or input).
-   **Stop vs. Complete vs. Delete:** You can Stop an active turn. Note that stopping *requests* an interruption—it does not promise force-detaching the agent or stopping active dev servers immediately. You can mark a conversation complete when done. Deleting removes the thread permanently from your `~/.agent-cockpit/` history.
-   **Imports:** The Projects menu can import Claude Code and Codex sessions belonging to the selected folder; the next message resumes the original CLI session. Recent work now appears automatically when opening a project. It reuses an existing Cockpit conversation or imports the selected session, and treats branch/files as current disk state.

## Working with Files & Markdown

-   **Documents & Editing:** Open **Files** to view, edit, and save text files in your project. You can edit Markdown files in the dedicated Markdown Document view.
-   **Attachments:** Add files and workflows to your message draft via the composer's **+** menu, or type **@** in the message and pick from the list (↑↓, then Enter or Tab; Esc hides it). Text files are limited to 100 KB, with a max of 8 attachments and 200,000 characters per prompt. Note that attachments and prompt text are sent directly to the agent (provider-bound).
-   **Moving around:** Home, Back, Forward and Up move between folders. The sidebar button at the left of the tabs hides the file list for more room, and Cockpit remembers that choice.
-   **Opening files in other apps:** **⋯ → Open in default app** asks first when the file can run something on your Mac (a `.command`, `.terminal`, `.app`, script, installer, or any executable file), and shows its real name. A file name with characters that hide or reorder text shows them visibly, as `⟨U+202E⟩`, so a script cannot pass for a PDF.
-   **Renaming and the Trash:** **⋯ → Rename…** edits the name and the extension in separate fields. When the file you are looking at goes to the Trash, the next file in that folder opens.
-   **Copying files in:** drag files from Finder onto the file list to copy them into the folder shown, or onto Your documents. Nothing is ever replaced: if the name is taken, the copy is named "name (copy)". Folders and symbolic links are skipped, and the list says why.
-   **Syntax colours:** code files are coloured by language in the Source view. Very large files (over about 120,000 characters) stay plain.
-   **Find and replace:** ⌘F searches the open file, ⌥⌘F also opens Replace. Enter and Shift+Enter step between matches, **Aa** matches case, and **Replace all** is one step that ⌘Z undoes. This works in the Source and Document views and in workflow instructions.
-   **Asking about lines:** select lines in a saved file and the main button becomes **Ask about lines a–b**. Only those lines go to the agent, labelled with their line numbers, and the message shows them as `file:a-b`. While the file has unsaved changes the button stays **Add to conversation**, because the lines on screen would not be the lines sent.
-   **Your documents:** notes Cockpit keeps for the project, outside the repository. The search box finds them by name or by a word inside, archived ones included. In **Project settings → Your documents folder** you can keep them in a folder of your own. Cockpit copies them there, leaves the old folder as it was, and refuses a folder inside the project so that agents and git never see them.
-   **Conflicts:** Cockpit detects if a file was changed externally while you or the agent were editing it and provides conflict handling (e.g., using **Reload from disk** or **Save mine as a copy**).

## Git & Version Control

-   **Branches:** The composer features a branch pill showing your current Git branch. You can search, switch, or create-and-switch branches.
-   **Restrictions:** Switching branches while an agent is busy is strictly refused (it is not queued for later).
-   **Dirty Changes:** Creating a *new* branch can carry uncommitted changes over, but switching to an *existing* branch requires you to commit or stash dirty changes first.

### Worktrees

A worktree is a separate checkout of the project on its own branch, so an agent can try something without touching your main checkout.

-   The workspace button above the conversations shows **Main checkout** or the worktree in use. **New worktree…** asks for a name, an optional base (empty means the main checkout's current commit; a branch, tag or commit also works) and a branch name. Uncommitted files in the main checkout are not copied, and Cockpit tells you how many.
-   Files, Changes and new conversations use the selected workspace. A conversation keeps its own workspace; one conversation can have agents working in two worktrees at once, each with its own queue and Stop.
-   **Manage worktrees…** lists each worktree with its branch and conversations. **Merge into the main checkout…** shows what would merge first, then runs Git's own merge; a conflict stays on screen until you resolve it and **Continue**, or **Abort** to put the main checkout back. Nothing is pushed.
-   **Remove…** runs only after a fresh check finds nothing that exists only in that worktree; its branch is kept. A worktree with changes, untracked or ignored files, or commits on no other branch can be kept or **Archive**d as it is. Cockpit never stashes, resets or force-deletes.

## Processes & Previews

-   **Processes:** Agents can run commands (like `npm run dev`) scoped to the project.
-   **Previews:** Agents can open local web pages (localhost only) in the embedded preview pane and inspect screenshots of them.
-   **Controls:** You can manually restart, inspect logs, or stop processes from the UI. Closing Cockpit shuts down its managed processes. Stopping or deleting a conversation leaves its dev servers running; stop those through the process controls.

## Workflows & Schedules

-   **Gallery & Editing:** Open **Workflows** to access saved instructions and prompts. You can edit existing workflows or pause them. Archiving a workflow hides it from normal views.
-   **Writing instructions:** instructions are a document with the Markdown toolbar, or plain Source. Type **@** in either to add a file or another workflow. ⌘F finds and replaces, ⌘S saves.
-   **Starting from a workflow:** a new conversation shows the project's workflows as cards. A card adds `@workflow:name` to your message and runs nothing until you send it. The gallery's featured **Design workshop** proposes three directions for a screen, shows them in the preview, and applies the one you pick.
-   **Agents and workflows:** by default an agent's `save_workflow` only adds a new workflow with its schedule off, after you approve. **Project settings → Let agents manage workflows** lets agents save, update and schedule them without asking. One exception: when an agent updates a workflow that runs with more than manual or plan permissions, or with your hooks, its schedule is paused until you turn it back on in Workflows.
-   **Schedules:** You can schedule workflows (e.g., run daily tests) with an interval (5 minutes to 30 days), or at a daily, weekday, or selected-weekday time in the saved local timezone and clicking **Save and enable schedule**.
-   **Missed Runs & Failures:** If Cockpit is closed, at most one missed run is started when you reopen it. Workflows that fail will not block subsequent scheduled runs but will report errors in their thread.

## Memory & Scopes

-   **Scoping vs. Sandboxing:** Each session's MCP tools (like process runners) are scoped tightly to its project directory. However, this is *not* a strict filesystem sandbox for the provider—the underlying agent CLI still runs on your machine with your user permissions.
-   **Local State vs. Project Files:** Cockpit stores UI state, schedules, and active metadata internally (Local State). Actual project edits apply directly to your working directory (Project Files).
-   **Thread Recovery:** Cockpit persists your individual conversations as plain files in `~/.agent-cockpit/`. Conversation state and cross-thread memory are separate stores.
-   **`memory.json` Recovery:** Cockpit maintains a separate `memory.json` (Project/Everywhere memory) for cross-thread context. If this file is malformed, Cockpit preserves its bytes and refuses memory reads and writes. Back it up and repair it deliberately; the app does not silently reset it or claim automatic recovery.
-   **Memory Controls:** Use the Memory view to edit Project or Everywhere entries. Project Instructions is a separate setting.

## Appearance & Sounds

-   The sun or moon button in the top bar switches between light and dark in one click; the Appearance button next to it also offers System, list density and what rows show.
-   Customize theme, sounds, and the activity view via settings.
-   Cockpit integrates with the macOS Dock to show active states. The Dock icon follows Cockpit's appearance, with a dark version in Dark.
-   A project's colour (Project settings) tints its tab, the send and primary buttons, the working and process badges, the Complete control and resize bars.

## Phone Access

1.  Install **Tailscale** on your Mac and phone, signing in with the same account. Allow Tailscale network extensions.
2.  In Cockpit, open **Phone access** and click **Turn on phone access**.
3.  Scan the QR code or open the HTTPS address on your phone.
4.  Choose **Ask my Mac**, match the 6-digit code, and click **Allow** on the Mac.
5.  You can view conversations, answer approvals, and manage runs from your phone's browser.
6.  **Revocation:** You can revoke phone access or disable Cockpit’s phone access from the Phone Access panel on your Mac. Revoking a phone also cuts off the conversation stream it has open at that moment.
7.  **Push Notifications (Experimental):** Notifications are an optional transmission. They require explicit browser notification permission on your phone. You can manage notification settings directly from the phone UI.

## Agent-to-Agent MCP

Cockpit exposes a Model Context Protocol (MCP) server so agents can manage their own workspace. Tools marked *Cockpit asks* show Cockpit's own approval card. It appears however the agent calls the tool, and you have 45 seconds to answer before the request lapses; the agent can ask again.
-   **Available Now:**
    -   `list_conversations`: Lists conversations within the calling project.
    -   `read_conversation`: Reads a specific conversation within the calling project.
    -   `start_process`: Runs a command such as `npm run dev` in the project and waits for its URL or first output (*Cockpit asks*; **Allow for this session** covers later starts and stops until the agent's session ends).
    -   `stop_process`: Stops it and everything it spawned (*Cockpit asks*).
    -   `list_processes`: The project's processes, status and URL.
    -   `read_process_output`: The log, incrementally.
    -   `open_preview`: Opens a local page (localhost only) in the preview pane.
    -   `inspect_preview`: Returns a screenshot of the local page to the agent. It is taken in a private browser session, cleared after every capture, so the agent never sees a local app as you are signed in to it. Neither preview tool can open Cockpit itself.
    -   `save_workflow`: Saves reusable instructions in the current project, with scheduling off (*Cockpit asks*). With **Let agents manage workflows** on in Project settings, it does not ask, can update a workflow by name, and can set a schedule (see Workflows & Schedules for the one exception).
    -   `recall` and `remember`: Search the project's and everywhere memory, and record a fact (`remember`: *Cockpit asks*; the card says when a note would be read in every project).
    -   `start_conversation`, `send_to_conversation`, `stop_conversation` (v0.1.1 and later): Cockpit shows a separate Allow/Deny card for every action, whatever the agent's own permissions. They are restricted to the calling project, refuse self and foreign targets and recursive delegation, and use durable request keys to suppress duplicates. The agent-written title stays on one line on the card, so it cannot imitate the card's own fields.

## Updates

-   **Install or update from Terminal:** `curl -fsSL https://raw.githubusercontent.com/Holodeck23/agent-cockpit/main/install.sh | sh` shows the [beta terms](../../BETA-TERMS.md), installs only after you type `agree`, checks the download against the release's `SHA256SUMS` and puts Cockpit in Applications, without the Gatekeeper block a browser download gets. Quit Cockpit first when updating.
-   **Check for Updates…** is in the Cockpit app menu (v0.1.3 and later). It reads the official GitHub release list, including prereleases, and only checks when you choose it.
-   **Copy Install Command** copies the Terminal line above. **Download in Browser** opens the official Apple-silicon DMG for that release instead; macOS then blocks its first launch until you choose **Open Anyway** in System Settings → Privacy & Security. To install a downloaded DMG: finish or stop running agents, quit Cockpit, open the DMG and drag Cockpit to Applications to replace the old copy. State in `~/.agent-cockpit/` is outside the app, so conversations and settings are kept.
-   If the check fails (offline, rate-limited, or the newest release has no installer yet), Cockpit says so; a failed check never reports "up to date". When GitHub can't be reached, **Troubleshooting** opens the network section of the troubleshooting guide.
-   After you install a newer version, Cockpit says **Updated to Cockpit x** once; **What's new** shows that version's notes.

## Help

-   **Help → Release Notes** shows what changed in the version you're running, inside Cockpit. Notes come from the same GitHub release list as Check for Updates and are shown as plain text.
-   **Help → Cockpit Guide** and **Troubleshooting** open these pages in your browser.
-   **Feedback** (top right of the window) reports a bug or sends an idea: type a title and what happened, and Cockpit opens a filled-in GitHub issue in your browser for you to check, add screenshots to and submit. Your Cockpit and macOS versions go in only while *Include* is ticked; nothing else, and nothing is sent until you submit it on GitHub. The issue is public, so leave out anything private.
-   **Help → Report a Problem…** opens a new GitHub issue with only your Cockpit and macOS versions filled in. Nothing else is sent; add what happened yourself.
-   Errors that look like a network problem (an agent that can't reach its provider, a failed update check) link to [Network problems](troubleshooting.md#network-problems).

## Data, Backup, and Privacy

-   **Data Location:** Cockpit state lives in `~/.agent-cockpit/` unless `COCKPIT_HOME` overrides it. Project files and the CLIs’ own credentials/session stores live separately.
-   **What leaves this Mac:** Cockpit keeps its own data on this Mac. These are the times something leaves it:
    -   **Always (beta terms):** crash and error reports, and a short record when Cockpit starts and stops, go to its developer through Sentry (EU region) ([terms](../../BETA-TERMS.md)). There is no setting to turn them off. A report holds the error and stack trace, Cockpit's version (with its Electron, Chromium and Node.js versions), the macOS version and the kind of Mac (processor and memory). Your home folder becomes `~`; the machine name, user, time zone, language, screen, file contents and screenshots are never sent, though error text can name a project or file. Reports carry no IP address of their own and ask Sentry not to record the one they arrive from.
    -   **Your agents:** every turn, including scheduled workflow runs, sends your prompt, attachments and whatever project content the agent reads to that agent's provider, through the CLI you installed. The agent's own tools (web search, MCP servers) can reach other services.
    -   **Only when you ask:** **Check for Updates** and **Help → Release Notes** read the public release list from GitHub's API. **Check for updates** on an agent in the picker reads that CLI's latest version from the npm registry (Claude Code and Codex). **Install** and **Update** download the agent's official installer or run its own updater. **Feedback** and **Help → Report a Problem…** open a GitHub issue page in your browser; nothing is posted until you submit it there. Sites you open in the in-app browser load as in any browser.
    -   **Phone access, if you turn it on:** your paired devices reach Cockpit over your own Tailscale network. A "Needs you" notification to a paired phone carries the project name and conversation title, encrypted for that phone, through its browser's push service (Google's or Apple's).
-   **Stored on this Mac:** conversations (your messages, the agents' replies, tool activity and attached images), workflows, schedules, settings, account profiles and worktree records live in `~/.agent-cockpit/`. Each conversation is a folder with its events and a readable `messages.md`. Account profiles keep each extra account's CLI sign-in in its own folder there (and in the Keychain for Claude Code), separate from your default CLI login. The agent CLIs also keep their own session history in their own folders (for example `~/.claude/` and `~/.codex/`).
-   **Backups:** To back up your Cockpit data, securely copy the `~/.agent-cockpit/` directory.
-   **Damaged files (after v0.1.4):** a crash, a power cut or a full disk can leave a conversation's files half-written. Cockpit skips the damaged part, keeps every other conversation listed, and never rewrites or deletes the file. See [Troubleshooting](troubleshooting.md#conversations--workflows).

## Extension Notes for Developers

If you want to extend Cockpit or develop new tools for it:
-   Verify adapter integrations locally using protocol stand-ins (e.g. `npm run proof:antigravity`).
-   Keep in mind that modifications to schemas require corresponding updates to the allowlists.
-   Consult the [Developer Guide](developer.md) for architecture, packaging, and testing specifics.
