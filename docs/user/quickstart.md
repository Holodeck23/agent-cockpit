# First-Run Quick Start

> **v0.1.5 prerelease (2026-10-07).** See the [tester checklist](tester-checklist.md). Features marked "in the next release" are on `main` but not in this download.

This page takes you from opening Cockpit to your first result.

## The welcome screen

The first time you open Cockpit with no saved projects or conversations, and you have not chosen **Skip for now**, you see the first-run screen. You have two paths.

1.  **Open a project.** Choose a folder on your Mac. Selecting a folder does not start an agent. Cockpit looks for recent Cockpit, Claude Code and Codex conversations in it and shows a **Recent work** card: the latest task, the agent, when it ran, the current branch and the changed files.
    *   **Resume and show me the app** continues that session with the default model and manual permissions. It checks the current files, asks before it starts the project's server, and then opens and inspects the app in Cockpit's browser pane.
    *   Use the **Conversation** and **Continue with** menus to pick another conversation or agent. Another agent gets the transcript as a handoff.
    *   **Start fresh** skips recovery. **Refresh recent work** looks again. With nothing recent, choose **Explore this project** for a short read of the files and changes and one suggested next step.
2.  **Try a 90-second sample.** Cockpit creates a small local app in its own sample folder and walks you through a real conversation, an approval, a running process and a preview. It needs Claude Code, Codex or OpenCode. Cockpit does not offer Antigravity for the sample or for **Resume and show me the app**. It can still explore a project (see [compatibility](compatibility.md#google-antigravity)).

Cockpit picks an installed agent for you and leaves the model and effort at the CLI's defaults. Permissions start on manual, so you stay in control. If no agent is installed, open the agent picker once you are in a project (or **Skip for now**) and install one. See [Agent CLIs](index.md#agent-clis).

**Skip for now** saves your choice and takes you to the normal workspace.

Calls to real providers use your own subscription allowance. Starting processes and drawing the screen are local.

## Your first conversation

1. **Start.** In a project, type what you want in the message box and press Enter. Cockpit sends your message to the agent through that agent's own CLI adapter. Separately, Cockpit adds its own tools (processes, previews, memory and so on) to the agent over MCP. MCP does not carry your prompt.
2. **Answer approvals.** When something needs your say, a card shows **Allow** and **Deny**, and sometimes **Allow for this session**. Which of the agent's own actions ask depends on the agent and the permission setting. Manual mode does not promise a card for every file edit. Cockpit's own tools (starting a process, saving memory or a workflow, controlling another conversation) always ask on Cockpit's card, and you have 45 seconds to answer. Google Antigravity cannot pause for approval, so it has no cards. See [compatibility](compatibility.md).
3. **Watch it work.** The status next to the title goes Starting, Working, then Ready. **Needs you** means an approval or a question is waiting. **Stop** asks the agent to interrupt the current turn.
4. **See the result.** The end of each turn has a result card with what changed in the folder and any checks you ran. **Changes** in the conversation header lists everything uncommitted in the folder. See [the guide](guide.md#changes-and-results).

## Servers and previews

When an agent needs a development server:

1.  **It asks.** The agent calls Cockpit's `start_process` tool and a card shows the exact command. Choose **Allow**.
2.  **It shows you.** Once the server prints a local address, the agent can call `open_preview`. The page opens in Cockpit's browser pane beside the conversation. `inspect_preview` gives the agent a screenshot.
3.  **You stay in charge.** Stop the server from the conversation's process chip or from the **Processes** page. Stopping a conversation does not stop its servers.

The sample aims for about 90 seconds, but the time depends on your provider's speed.
