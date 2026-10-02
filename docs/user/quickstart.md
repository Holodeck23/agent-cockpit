# First-Run Quick Start

Welcome to Agent Cockpit! This guide will take you from launching the app to seeing your first result.

## The Welcome Screen

When you first launch Cockpit with a fresh installation, you will see the **First-run director**. Here you have two main paths:

1.  **Open a project:** Use the native folder picker to select a project on your Mac, then click **Explore this project**. Cockpit will open the project, select an installed agent automatically, and help you get oriented. Selecting a folder does not launch an agent on its own.
2.  **Try a 90-second sample:** This starts a genuine local sample app (a dependency-free project) stored in Cockpit's own sample folder. It will guide you through a real conversation, an approval prompt, running a process, and opening a preview in Cockpit's preview pane. This uses a plain-language request and requires Claude Code, Codex, or OpenCode to be installed.

### Automatic Agent Defaults

During your first run, Cockpit automatically chooses an installed agent for you, leaving the model and effort settings at their CLI defaults. It uses manual permissions to ensure you are in control.

### Skip For Now

If you are an existing user or want to dive straight in, you can click **Skip for now**. This persists your choice, and you will enter the normal Cockpit workspace where your existing projects and conversations reside.

## Your First Conversation

1. **Start a Conversation:** Once you are in a project (or the sample), type a request in the composer and press Enter. This sends your request to the agent using the Cockpit MCP (Model Context Protocol).
2. **Understand Approvals:** When an agent wants to perform an action (like running a development server or editing a file), Cockpit will pause and display an approval prompt. For supported agents, you must review the action and click **Allow** or **Deny**. *(Note: Google Antigravity uses a different headless permission model without host approval cards—see the Agent Compatibility page for details.)*
3. **See the Result:** After approving the necessary steps, the agent completes the work.

## Working with Processes and Previews

When an agent needs to start a development server or run an app:
1.  **Start an app:** The agent will use a tool (like `start_process`) to run a command. You must allow this.
2.  **Inspect the preview:** Once running, the agent can use `open_preview` to open the local web page inside Cockpit's preview pane.
3.  **Stop the process:** When finished, the agent can stop the process, or you can manually stop it from the conversation's process controls.

*Note: While the sample aims for a 90-second loop, actual completion times depend on the live provider's speed. Calls to live providers consume your agent subscription allowance. Running local processes and rendering the UI is entirely local.*
