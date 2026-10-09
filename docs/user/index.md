# Installation and Updating Guide

> **v0.1.4 prerelease (2026-10-03).** Easier reading and fewer missed turns: conversations stay where you're reading, ⌘F find, copy a message and Mac notifications. v0.1.3 added Check for Updates. Same-Mac acceptance passed on a second account for v0.1.2; independent human and other-Mac installation remain open. See the [tester checklist](tester-checklist.md).

*(Documented for v0.1.4)*

## System Requirements

Agent Cockpit is built exclusively for macOS running on Apple Silicon. Other platforms and Intel Macs are not officially supported. The packaged app includes its runtime. Install any runtime required by your chosen agent separately.

## Installation

The quickest way, and the one macOS does not block, is one line in Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/Holodeck23/agent-cockpit/main/install.sh | sh
```

It shows the [beta terms](../../BETA-TERMS.md) and installs only after you type `agree`. Then it downloads the newest release, checks it against the release's `SHA256SUMS` and puts Cockpit in Applications. A download made with `curl` is not marked as coming from the internet, so Gatekeeper does not stop the first launch. To update later, quit Cockpit and run the same line again.

Or install the DMG by hand:

1. Download the latest `Cockpit-<version>-arm64.dmg` from the [Releases page](https://github.com/Holodeck23/agent-cockpit/releases).
2. Open the `.dmg` file.
3. Drag **Cockpit.app** to your **Applications** folder.

### Bypassing Gatekeeper

Cockpit is currently not notarized by Apple. When you first open it, macOS Gatekeeper will block it with a message saying "**Cockpit** Not Opened".

*   **Do not click "Move to Trash"**. Click **Done**.
*   Open your Mac's **System Settings** and go to **Privacy & Security**.
*   Scroll down and look for a message about Cockpit being blocked. Click **Open Anyway**.
*   **Alternative:** Open the Terminal and run this exact command to remove the quarantine flag:
    `xattr -dr com.apple.quarantine /Applications/Cockpit.app`

## Crash reports

Cockpit is in beta, and the beta is conditional on its [terms](../../BETA-TERMS.md): Cockpit sends crash and error reports to its developer through [Sentry](https://sentry.io) (EU region), with no setting to turn them off. You accept the terms when installing from Terminal, or when Cockpit first opens. A report holds the error message and stack trace, Cockpit's version, and the macOS version and kind of Mac. Cockpit also sends a short record when it starts and stops, so the developer can see how many people run each version and how often it crashes. It carries the same version and Mac details and nothing about your work. Your home folder is replaced with `~`, and the machine name, user, screenshots, recordings, crash memory dumps and file contents are never sent. Error text can still name a project or file. Development and test builds never send any.

## Installing Agents

Cockpit connects to agents that are already installed on your Mac. You must install the CLIs and sign in using your own accounts and subscriptions. Cockpit automatically resolves your login-shell `PATH` and checks fallback directories (like Homebrew and user-level npm installs) to find these CLIs, even when launched from the macOS Finder.

### Claude Code
Install globally using npm (requires Node.js):
```bash
npm install -g @anthropic-ai/claude-code
```
Sign in with your Anthropic account to use your Claude subscription limit.

### Codex
Follow the official documentation (e.g., via `npm` or official binary) to install the `codex` executable. Cockpit automatically invokes it in its `app-server` mode. Requires a valid Codex API or subscription setup.

### Google Antigravity
Install the Antigravity `agy` CLI according to Google's official setup instructions. You must have valid subscription credentials configured for the CLI.

### OpenCode (OpenRouter)
Install OpenCode via standard `npm` or binary. OpenRouter is accessed through OpenCode, which will require setting up your OpenRouter API keys in its configuration.

## Identifying Your App Version

To verify which copy you are launching (especially if you have older copies in your Downloads folder), right-click the Cockpit app icon in Finder, choose **Get Info**, and check the version and path. A path of `/Applications/Cockpit.app` alone does not prove currency—it might be a stale installation. Remember that development builds or feature branches might share the same version number but have different features.

## Updating

When a new version is released:
1. Download the new `.dmg` file.
2. Open it and drag the new **Cockpit.app** into your **Applications** folder.
3. Choose **Replace** when macOS asks.

Quit Cockpit before replacing it, and back up its state first. Replacing the app bundle does not replace `~/.agent-cockpit/` (or the folder selected by `COCKPIT_HOME`). Conversation history, workflows and settings live there; project files stay in their original folders. Building from the source repository also does not automatically overwrite the app in your `/Applications` folder. The built app lives in `release/mac-arm64/Cockpit.app`.
