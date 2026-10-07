# Agent Compatibility and Limitations

> **v0.1.5 prerelease (2026-10-07).** See the [tester checklist](tester-checklist.md). The "Verification" notes are the last recorded evidence, not a promise about your CLI version or account.

Cockpit gives you one interface over several coding agents. Each agent has its own CLI, so each has its own requirements and limits.

## Supported agents

| Agent | CLI | Verification | Notes |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `claude` (`@anthropic-ai/claude-code`) | Live resume checks and selected packaged proofs passed | Full approvals, processes, previews, file editing, images, **Use my Chrome**. Real usage is bounded by Anthropic's limits. |
| **Codex** | `codex` (run in its `app-server` mode) | Live resume checks and selected packaged proofs passed | Full approvals, processes, workflow schedules, attachments and images. |
| **Google Antigravity** | `agy` | Live subscription resume and a packaged stand-in passed | No approval cards. Cockpit's tools only where you turn them on. See below. |
| **OpenCode** | `opencode` (run as `opencode acp`) | Packaged stand-in passed. Live OpenRouter is untested | The way to reach OpenRouter models, over the Agent Client Protocol. |

Install, update and sign-in from the agent picker work for Claude Code, Codex and Antigravity (and sign-in for Claude Code and Codex). OpenCode is manual. See [Agent CLIs](index.md#agent-clis).

## Important distinctions

*   **Antigravity is not the standalone Gemini CLI.** Cockpit works with the `agy` CLI. Make sure the `agy` on your `PATH` is the right one.
*   **OpenCode is not OpenRouter.** Cockpit does not connect to OpenRouter. You set up your OpenRouter keys in OpenCode, and Cockpit talks to OpenCode. Models are typed as `openrouter/<provider>/<model>`.
*   **Detection is not sign-in.** Cockpit finds a CLI on your `PATH` (your login shell's, plus the usual install folders). That does not mean it is signed in or has quota. The picker shows what each CLI reports about sign-in, and "Sign-in not confirmed" is a real answer.
*   **Stand-ins are not live providers.** Many checks run against recorded protocol stand-ins. Live behaviour also depends on the provider's uptime, speed and your limits.
*   **Keep CLIs current.** Cockpit checks a Claude Code CLI's advertised options before each launch. An older Codex CLI may reject a newer default model before the task starts.

## Known limits by agent

### Claude Code
*   **Public v0.1.1 only:** Claude Code 2.1.220 failed at startup with `unknown option '--permission-prompts'`. This was a launch compatibility bug, not your sign-in or project. Your conversation is kept.
*   **v0.1.2 and later:** Cockpit reads the selected CLI's `--help` before launch, keeps manual approval handling, and leaves out the newer permission-prompts option when the CLI does not offer it. An unsupported option or a failed check ends the turn with guidance to update the CLI or choose another agent. Cockpit does not upgrade your CLI on its own. You can use **Update** in the picker.
*   **Version evidence (2026-10-03):** real Deny, Allow and native-resume checks passed with 2.1.220 and 2.1.288. This does not show that every version between them works, or that 2.1.220 is the earliest compatible release.
*   **Use my Chrome** needs this Claude Code to offer `--chrome` and the Claude extension installed in Chrome. A call Chrome does not answer within 30 seconds stops the turn once.

### Codex
*   Approvals for commands, file changes and Cockpit's MCP tools all show as the same card.
*   If `~/.codex/config.toml` pins a model newer than the CLI supports, every turn fails. Update Codex, or set a model on the conversation. See [troubleshooting](troubleshooting.md#agents-and-launch-issues).

### Google Antigravity
*   **No approval cards.** Antigravity cannot pause to ask when Cockpit runs it. Its modes are **Bypass permissions** (the default Cockpit uses), **Configured permissions (Antigravity settings)** (workspace edits proceed and commands that would need approval are denied) and **Plan only, no changes**.
*   **Cockpit's tools are opt-in per project.** Antigravity has no per-launch way to attach Cockpit's MCP tools, and Cockpit does not edit your global Antigravity configuration. In **Projects → <project name> settings…**, tick **Give Antigravity Cockpit's tools**. Cockpit then adds its own plugin in the project's `.agents/plugins/cockpit` folder (Git ignores it), and the session's access key is never written there. Antigravity gets processes, previews, memory and the other tools, and the project guidance, when it next starts. Turning it off removes only the files Cockpit made. Cockpit leaves other plugins and anything you changed in place.
*   **Without that opt-in**, Antigravity has none of Cockpit's tools. Either way, Cockpit never offers Antigravity for the 90-second sample or for **Resume and show me the app**, which rely on the process and preview tools. It can still **Explore this project**.
*   **Models and usage.** **Refresh** in the picker lists the models `agy` reports, and usage comes from what it reports. Effort is low, medium or high. Higher Cockpit levels count as high.
*   **Images.** Antigravity is given the stored image's path, because it reads files itself.

### OpenCode
*   Models and sign-in come from OpenCode's own configuration. Cockpit shows a permission request as an approval card and sends images only when OpenCode says it accepts them.

## Phone approvals and notifications

*   A paired phone can read and answer approvals and questions, reply, and stop a turn. See [Phone access](guide.md#phone-access).
*   **Push notifications** work in code and in tests with a stand-in sender. Delivery to a real phone over a real tailnet is still a manual acceptance check that has not been completed. It needs Tailscale and a browser that allows notifications.
*   **Phone live preview** (in the next release) has been run against a stand-in `tailscale`, not yet the real tailnet from a real phone.
