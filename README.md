# Agent Cockpit

Cockpit is a macOS desktop app that runs installed coding-agent CLIs using your existing subscriptions or provider setup. Supported agents include Claude Code, Codex, Google Antigravity, and OpenCode (OpenRouter is accessed through OpenCode).

## Supported Platforms

Currently, Cockpit is built for macOS and Apple Silicon (ARM64). It expects the supported Agent CLIs to be installed and available on your system `PATH`.

## Quick Links

- [Installation and Updating Guide](docs/user/index.md)
- [First-Run Quick Start](docs/user/quickstart.md)
- [User Guide](docs/user/guide.md)
- [Agent Compatibility and Limitations](docs/user/compatibility.md)
- [Troubleshooting](docs/user/troubleshooting.md)
- [Developer Guide](docs/user/developer.md)

## Download

Releases are provided as `.dmg` packages for Apple Silicon Macs.

> **Note**: Cockpit is currently distributed without Apple notarization. On the first launch, macOS Gatekeeper will block the app and display "**Cockpit** Not Opened".
> Do not choose "Move to Trash". Instead, click **Done**, go to **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
>
> Alternatively, you can run `xattr -dr com.apple.quarantine /Applications/Cockpit.app` in your terminal to allow the app to launch.

## Licence

Cockpit is not open source. The code is published to be read; copying, modifying or redistributing it needs written permission. You may run the official builds from the Releases page for your own use. See [LICENSE](LICENSE).
