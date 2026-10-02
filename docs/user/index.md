# Installation and Updating Guide

## System Requirements

Agent Cockpit is built exclusively for macOS running on Apple Silicon (M1/M2/M3/M4 series). Other platforms and Intel Macs are not officially supported.

## Installation

1. Download the latest `Cockpit-...-arm64.dmg` release.
2. Open the `.dmg` file.
3. Drag **Cockpit.app** to your **Applications** folder.

### Bypassing Gatekeeper

Cockpit is currently not notarized by Apple. When you first open it, macOS Gatekeeper will block it with a message saying "**Cockpit** Not Opened".

*   **Do not click "Move to Trash"**. Click **Done**.
*   Open your Mac's **System Settings** and go to **Privacy & Security**.
*   Scroll down and look for a message about Cockpit being blocked. Click **Open Anyway**.
*   **Alternative:** Open the Terminal and run this exact command to remove the quarantine flag:
    `xattr -dr com.apple.quarantine /Applications/Cockpit.app`

## Installing Agents

Cockpit connects to agents that are already installed on your Mac. You must install the CLIs and sign in using your own accounts and subscriptions.

### Claude Code
Install globally using npm (requires Node.js):
```bash
npm install -g @anthropic-ai/claude-code
```
Sign in with your Anthropic account to use your Claude subscription limit.

### Codex
Follow the official documentation to install the Codex app-server. Make sure the executable is on your PATH. Requires a valid Codex API or subscription setup.

### Google Antigravity
Install the Antigravity CLI according to Google's setup instructions. You must have valid subscription credentials configured for the CLI.

### OpenCode (OpenRouter)
Install OpenCode (via standard `npm` or binary). OpenRouter is accessed through OpenCode, which will require setting up your OpenRouter API keys in its configuration.

## Identifying Your App Version

To verify which copy you are launching (especially if you have older copies in your Downloads folder), right-click the Cockpit app icon in Finder, choose **Get Info**, and check the version and path. Remember that development builds or feature branches might share the same version number but have different features.

## Updating

When a new version is released:
1. Download the new `.dmg` file.
2. Open it and drag the new **Cockpit.app** into your **Applications** folder.
3. Choose **Replace** when macOS asks.

**Your data is safe.** Updating or replacing the app in `/Applications` will not delete your projects, workflows, or conversation history. All user data is stored safely in `~/.agent-cockpit/` in your user directory. Building from the source repository also does not automatically overwrite the app in your `/Applications` folder.
