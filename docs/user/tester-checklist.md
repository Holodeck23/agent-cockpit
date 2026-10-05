# First test on your own Mac

Use the [v0.1.4 prerelease](https://github.com/Holodeck23/agent-cockpit/releases/tag/v0.1.4) on an Apple-silicon Mac. This is an early, ad-hoc-signed build, not notarized by Apple. **Cockpit → Check for Updates…** finds newer releases; installing them stays manual.

1. Install and sign in to a current Claude Code or Codex CLI; confirm a simple request works in Terminal. Cockpit uses your own provider allowance. OpenCode is also available, but live OpenRouter has not been verified; Antigravity cannot run the recovery preview tools.
   Record the exact CLI version and executable path (`claude --version` and `command -v claude`, or the Codex equivalents). Cockpit probes Claude's advertised launch options and preserves manual approval handling; see [compatibility](compatibility.md#claude-code). A successful terminal reply alone does not establish Cockpit approval compatibility.
2. Download `Cockpit-0.1.4-arm64.dmg`, open it, and drag Cockpit to Applications. Quit any older Cockpit before replacing it. If blocked, follow [first-launch instructions](index.md). Do not delete your existing projects or agent data.
3. Start a stopwatch when you open Cockpit. Select a web project you have already worked on with Claude Code or Codex. Confirm the recovery card identifies the task and current branch/changes correctly.
4. Choose **Resume and show me the app**. Review the requested startup command before allowing it. Record how long it takes to see a working preview and an agent conclusion describing what it inspected. Do not count a blank pane or an unsupported success claim.
5. Try one real interaction in the app. Ask a follow-up, or save the verified startup as a workflow if useful. Confirm your original conversation and project files remain available.
6. No suitable project? Try the 90-second sample instead and identify it as a sample test in your feedback. If a step fails, stop the timer at the blocker and copy the visible error; do not reset your state to hide the failure.

Send feedback to the group or [open an issue](https://github.com/Holodeck23/agent-cockpit/issues) yourself. Include: Mac model/chip and macOS version; Cockpit version; agent and CLI version; install result; whether recent work was found; time to useful result; number of approval prompts; whether the preview interaction and follow-up worked; exact error if any. Remove private paths, tokens and client details from screenshots/logs.

The developer's three fresh-state runs with an already authenticated Claude CLI took 19.9–22.9 seconds. Those were automated runs on a generated dependency-free app, not independent tester results. This checklist is deliberately still uncompleted for a group member's own Mac.
