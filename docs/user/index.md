# Installation and Updating Guide

> **v0.1.5 prerelease (2026-10-07).** This is the newest download. A few things on `main` are not in it yet. They are marked "in the next release" in these docs. See the [tester checklist](tester-checklist.md).

New here? Read this page, then the [quick start](quickstart.md). The other pages are the [user guide](guide.md), [agent compatibility](compatibility.md), [troubleshooting](troubleshooting.md) and the [developer guide](developer.md).

## System requirements

Cockpit is built for macOS on Apple silicon. Intel Macs and other systems are not supported. The app includes its own runtime, so you do not need Node.js. Each agent you want to use needs its own CLI, which you can install from Cockpit (see below).

## Installation

1. Download `Cockpit-0.1.5-arm64.dmg` from the [Releases page](https://github.com/Holodeck23/agent-cockpit/releases).
2. Open the `.dmg` file.
3. Drag **Cockpit.app** to your **Applications** folder.

### First launch and Gatekeeper

Cockpit is not notarized by Apple. The first time you open it, macOS blocks it with "**Cockpit** Not Opened".

*   Do not click **Move to Trash**. Click **Done**.
*   Open **System Settings → Privacy & Security**.
*   Scroll down to the message about Cockpit and click **Open Anyway**.
*   Or, in Terminal, remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Cockpit.app`

## Agent CLIs

Cockpit runs the agent CLIs already on your Mac, with your own accounts and subscriptions. It never holds your provider keys. It finds each CLI on your login shell's `PATH`, plus the usual folders (Homebrew, `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`), so it works when you open it from Finder.

You can check, install, update and sign in from Cockpit itself:

1. Open the agent picker (the button beside the message box that shows the agent and model).
2. Choose the agent. The panel shows whether it is installed, its version, where it lives, how it was installed, whether it is signed in, and when Cockpit last checked.
3. **Refresh** checks again now. Cockpit never checks in the background.

What Cockpit can do for each CLI:

| Agent | Install from Cockpit | Update from Cockpit | Sign in from Cockpit |
| :--- | :--- | :--- | :--- |
| Claude Code | Yes, with the official installer | Yes, when installed by its native installer, npm or Homebrew | Yes, opens your browser |
| Codex | Yes, with the official installer | Yes, for installs Cockpit recognises | Yes, opens your browser |
| Google Antigravity | Yes, with the official installer | Yes, when installed by its native installer | No. Run `agy` once in Terminal |
| OpenCode | No. Install it yourself (see below) | No. Run `opencode upgrade` | No. Run `opencode auth login` |

How these work:

*   **Every action asks first.** You see where it installs and what to expect, then you confirm. Nothing runs on its own.
*   **Installs** download the vendor's own script from the vendor's own address and put the CLI in `~/.local/bin`. Cockpit does not use `sudo`. It does not install a second copy over one that exists.
*   **A changed installer is never run silently.** If the vendor's script differs from the one this release of Cockpit reviewed, Cockpit says so and stops. **Install this version anyway** runs exactly the new version it showed you.
*   **Updates wait.** An update waits until every conversation using that CLI is idle, and new sessions with it wait too. If you quit Cockpit while an update waits, it does not resume by itself. Choose **Resume update** or **Cancel**.
*   **Manual steps are shown as exact commands** when Cockpit cannot do it safely, for example when Homebrew's folder is not writable by you. Run the command in Terminal, then choose **Refresh**.
*   **Update checks** read the npm registry for Claude Code and Codex. If the check fails, Cockpit says so and never reports "up to date" by guessing. **Skip** hides one version, and never blocks **Update**.
*   Install, update and sign in work on the Mac only, not from a phone.

To install OpenCode yourself, run `curl -fsSL https://opencode.ai/install | bash` in Terminal, then choose **Refresh**.

Detecting a CLI does not prove it is signed in or has quota. If an agent fails with an authentication error, sign in from the picker or in Terminal.

## Identifying your app version

Right-click the Cockpit icon in Finder, choose **Get Info**, and check the version and path. `/Applications/Cockpit.app` alone does not prove it is current. Cockpit's own **Cockpit → About Cockpit** shows the version too. A version number does not tell you which `main` commit a build came from, so check the release notes when you test a feature.

## Updating

**Cockpit → Check for Updates…** (v0.1.3 and later) reads the public release list and shows the newest version with its notes. It only checks when you choose it. **Download Update** opens the official DMG in your browser. Then:

1. Finish or stop running agents, then quit Cockpit.
2. Open the new `.dmg` and drag **Cockpit.app** into **Applications**.
3. Choose **Replace** when macOS asks.

Nothing is installed or restarted for you. Replacing the app does not touch your data. Conversations, workflows and settings live in `~/.agent-cockpit/` (or the folder in `COCKPIT_HOME`), and project files stay in their own folders. Back that folder up first if you care about the history.

Building from source does not touch `/Applications`. A local `npm run package` writes the app to `release/mac-arm64/Cockpit.app` and the installer to `release/Cockpit-<version>-arm64.dmg`. The scripted release build writes to `release/v<version>/` instead. See the [developer guide](developer.md#releasing).

## Uninstalling

Quit Cockpit and delete **Cockpit.app**. To remove your data too, copy `~/.agent-cockpit/` somewhere safe first, then delete it. The agent CLIs keep their own sign-in and session files elsewhere, and neither step removes them.
