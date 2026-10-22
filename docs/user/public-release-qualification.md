# Public v0.1.8: a complete two-agent development walkthrough

On 22 October 2026, the exact public Cockpit v0.1.8 download passed a native, live-provider development walkthrough on the owner's Apple-silicon Mac. The owner also completed a hands-on interaction and reload check in its embedded preview.

## The artifact tested

The [official release](https://github.com/Holodeck23/agent-cockpit/releases/tag/v0.1.8) DMG was downloaded fresh. SHA-256 `ca428d8b45b862c259cb8c1433ac6e60cfaf4dd7fa378499450ff346e7a27b96` matched both published `SHA256SUMS` and GitHub's asset digest. After installation in `/Applications/Cockpit.app`, all **280 file/link entries** matched the mounted download; deep strict signature verification passed.

Installed `app.asar` SHA-256: `f2be60feabf6116267bd0a270c3eb371917171863e6184689503c89b22f1159e`. Release source: `791deeae8553c6a002a0ea286155f504c5a04342`. This is the public artifact, distinct from the earlier local `7d276213` build tested on 21 October. The old app and private state were preserved before installation.

## What happened in the working app

The walkthrough used real **Claude Code 2.1.308 / Sonnet** and **Codex 0.162.1 / gpt-6.1-sol**, with manual permissions and fictional project data. It was operated by an assistant except for the owner's explicit preview check.

| Step | Observed result |
| --- | --- |
| Launch and open a project | Existing state remained visible; a bounded fixture folder opened as a new project. |
| Start Claude and answer approvals | Starting, Working, Needs you and Ready were visible. Three outside-folder context requests were denied; an HTML write and syntax check were allowed. |
| Create an actual development result | Claude wrote an accessible three-item release checklist with a live count, deliberately leaving persistence for the next agent. |
| Quit/reopen and resume Claude | The saved conversation and approval records returned. A no-tool follow-up recalled `AMBER-2841`, all three items and the unfinished persistence feature. |
| Review the handoff | Before switching, the UI showed **5,038 characters · the whole conversation**, with Back and Start handoff. Codex was set to Ask before acting. |
| Continue the task with Codex | Without the label or feature repeated in the new prompt, Codex identified both, then implemented resilient localStorage persistence and a dependency-free local server. |
| Start server, read logs and inspect preview | Cockpit asked before `node server.cjs`; Allow started it on loopback port 43128. Codex read its output, opened the embedded preview and inspected it. |
| Owner hands-on acceptance | The owner checked Install and Resume and reloaded the preview, then confirmed: **“Both ticks remain; 2 of 3 completed.”** The native UI also showed both checked and the matching count. |
| Quit/reopen and resume Codex | The saved task returned. A no-tool follow-up recalled the label, Claude's work, Codex's additions and the preview URL. Final state: Ready, 14 messages. |
| Quit cleanup | After normal quit, the test server's loopback port refused connections. This check concerns that server, not every possible child process. |

Codex's syntax and Node behavior checks also passed, covering persistence, malformed storage, unavailable storage and counter updates. These are separate from the owner's browser interaction.

The resulting fictional [checklist](../proof/public-release-2026-10-22/index.html), [local server](../proof/public-release-2026-10-22/server.cjs) and [structured evidence summary](../proof/public-release-2026-10-22/evidence.json) are retained with this write-up. Follow the [first-run guide](quickstart.md) for the launch, resume, permission, handoff and storage steps.

## Scope

This establishes the bounded workflow in the exact public release on one Mac, with owner hands-on confirmation. Independent-person and another-Mac acceptance remain untested. It does not establish arbitrary long-task completeness, automatic quota failover or finished native memory/hooks/skills/connector inheritance (W13). Apple silicon only; ad hoc signed and not notarized. Provider calls consume the user's allowance, and production beta telemetry follows the beta terms.
