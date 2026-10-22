# First run: Claude, Codex and an explicit handoff

Updated 22 October 2026. This guide describes the installed local build qualified on 21 October, with its archive identity rechecked on 22 October. The public download is v0.1.8, but it is a different build. The live results below do not qualify that download.

## Before you start

Use a macOS Apple-silicon Mac with Claude Code and Codex installed and signed in to your own accounts, with available usage. Cockpit runs those CLIs; it does not supply inference or a subscription. The live check used Claude Code 2.1.306 (Sonnet) and codex-cli 0.162.1 (gpt-6.1-sol); other versions and models were not established by this check. An installed-CLI badge alone does not prove login or quota.

For a new installation, follow the [installation guide](index.md) and [public v0.1.8 release](https://github.com/Holodeck23/agent-cockpit/releases/tag/v0.1.8). Installing the public release does not reproduce the qualified local build. It is an early beta, ad hoc signed and not notarized; review its beta terms before installing.

## Launch and start a conversation

1. Open **Applications → Cockpit**, using `/Applications/Cockpit.app`. Keep one installed copy. Check **Get Info** for the path and version; matching version numbers alone do not establish build identity.
2. Use **Open a project**, or **Projects → Open folder…**, to select an existing folder. Selecting it does not start an agent. With existing state, Cockpit opens the saved workspace; **Skip for now** leaves the first-run introduction.
3. In **Conversations**, click **New conversation** (**+**). Open **Agent settings**, choose Claude Code, and check the account and model. Choose manual permissions / **Ask before acting**. Settings are remembered separately for each agent, so check again when choosing Codex; a remembered draft can use bypass permissions.
4. Send a small request. For example: “Remember this fictional code word for this conversation: LANTERN-4729. Reply with the word and ready. Do not use tools or change files.” Wait for the reply and **Ready**. Starting and Working indicate activity, not completion.

To start directly with Codex, choose Codex in step 3. Yesterday's live test started with Claude and reached Codex through the handoff below; a fresh Codex conversation was not separately retested.

## Resume after closing Cockpit

Wait until the turn is Ready, quit Cockpit normally, then open the same installed app. Select the same project and the saved conversation in its list. Send “What fictional code word did I ask you to remember? Do not use tools or change files.” The tested Claude conversation recalled it after a full app restart; Codex also recalled it after the handoff and another restart.

Opening a project can also offer recent-session recovery. That separate import/recovery path and **Resume and show me the app** were not tested in this qualification. Use the saved Cockpit conversation for the verified route. If it is missing, check the project and data location before creating a replacement or deleting anything.

## Review and send the handoff

1. Wait for the current turn to finish. Open **Agent settings**, choose Codex, check its account/model and **Ask before acting**, then choose **Switch…**.
2. Read **What Codex receives**. Check the actual text, character count and whether it says **the whole conversation** or lists earlier messages left out. Add any missing goal or decision to the conversation, then review again. **Back** cancels the switch.
3. Choose **Start handoff** only when the briefing is right. If Cockpit says the conversation changed since review, reopen the review before trying again.
4. Send the code-word question above, without repeating the word. In the live check Codex answered correctly after reviewing a 770-character handoff, and retained it after a full quit/reopen.

The target gets a fresh provider session with a textual briefing; provider-side history and hidden reasoning do not transfer. Source inspection shows tool-use notes and image-file references rather than complete tool results or embedded image contents. The handoff budget is 400,000 characters; longer histories can omit earlier messages. A short code-word check does not prove long-task or long-context completeness. Automatic failover on a usage limit is not established: the verified route is an explicit user-reviewed switch.

## Where your data lives

Cockpit normally stores state outside your project in `~/.agent-cockpit/` (`COCKPIT_HOME` can override it). Each conversation has `threads/<id>/meta.json`, `events.jsonl` and a readable `messages.md`; attachments and other state are also under the Cockpit data root. Project edits stay in the selected project folder. The CLIs keep their own credentials and session stores separately, normally under `~/.claude/` and `~/.codex/`, or a selected account profile. Cockpit's cross-conversation memory is separate from its transcript and from native CLI memory.

With Cockpit closed, securely back up the data root before repair or migration. Replacing the app does not replace that folder. Deleting a conversation removes its Cockpit history and is not a backup method. Never publish the data root or account profiles as proof.

Local storage does not mean offline inference: your prompts and content read by an agent go through its CLI to its provider. Production beta builds also send crash/error reports and start/stop telemetry under the [beta terms](../../BETA-TERMS.md); error text can name project files. See [data and privacy](guide.md#data-backup-and-privacy).

## What this qualifies—and what remains open

The 21 October assistant-operated, same-Mac check passed installed launch, both CLI detections, Claude start/resume, explicit Claude-to-Codex handoff and Codex resume. Four real replies completed with Ready and zero changed paths reported. The 22 October work checked identity and instructions; it did not rerun those provider tests or establish independent-user acceptance.

| Artifact | Identity and boundary |
| --- | --- |
| Qualified installed v0.1.8 | Source `5ed194a9524759abbe528509ff1e2bc532b5c806`; `app.asar` SHA-256 `7d2762130c155ce4c5bb9a7e4a6c9106128ce5c29124c4cd4a41347ab3969189`. |
| Saved public-release v0.1.8 package | Source `791deeae8553c6a002a0ea286155f504c5a04342`; `app.asar` SHA-256 `f2be60feabf6116267bd0a270c3eb371917171863e6184689503c89b22f1159e`. Different artifact; no fresh download/install or equivalent live flow was tested on 21–22 October. |

Windows, Linux and Intel Macs are unsupported. Full inheritance of native memory, hooks, skills and connectors (W13) remains unfinished and is not qualified here. Simultaneous conversations, approval execution, Stop, dev servers/previews and usage-limit handling were not retested in this bounded check. Antigravity, OpenCode/OpenRouter and physical-phone notifications are outside it; see [compatibility](compatibility.md) for their separate limitations. Another-Mac installation, independent-person usability and arbitrary-task continuity remain open.
