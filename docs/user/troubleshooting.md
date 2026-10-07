# Troubleshooting

> **v0.1.5 prerelease (2026-10-07).** Parts marked "in the next release" are on `main` but not in the v0.1.5 download. See the [tester checklist](tester-checklist.md).

Cockpit is built to fail safely and keep your work. Sections: [First launch](#first-launch) · [Agents and launch issues](#agents-and-launch-issues) · [Conversations and workflows](#conversations-and-workflows) · [Files and previews](#files-and-previews) · [Phone access](#phone-access) · [Network problems](#network-problems) · [Cockpit itself](#cockpit-itself)

**Data safety.** Before any recovery step that touches files, copy the state folder first. It is `~/.agent-cockpit/`, or the folder in the `COCKPIT_HOME` environment variable. Never delete unique work, clear credentials or bypass macOS permissions as a casual fix.

## First launch

**Symptom:** macOS says "**Cockpit** Not Opened".
*   **Cause:** Cockpit is not notarized by Apple.
*   **Recovery:** Do not choose **Move to Trash**. Click **Done**, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/Cockpit.app` in Terminal. See [installation](index.md#first-launch-and-gatekeeper).

**Symptom:** Cockpit opens but features from these docs are missing, or the UI looks wrong.
*   **Cause:** You may be running an older copy, such as an old `.dmg` in Downloads.
*   **Recovery:** Right-click the Dock icon, choose **Options → Show in Finder**, and check it is the copy in `/Applications`. Check the version in **Cockpit → About Cockpit** and the release date. Features marked "in the next release" are not in v0.1.5.

## Agents and launch issues

**Symptom:** "Claude Code isn't installed or isn't on PATH. Install it from Agent settings, or switch this conversation to another agent." (or the same for Codex, Antigravity or OpenCode).
*   **Cause:** Cockpit cannot find the CLI. An app opened from Finder does not get your terminal's `PATH`. Cockpit asks your login shell for its `PATH` once, when it starts (this waits up to 5 seconds), and always adds `~/.local/bin`. If the shell cannot be asked, it falls back to the usual folders (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`). A CLI in `~/.nvm` or another custom place may be missed, and a change to your shell profile after Cockpit started is not seen.
*   **Recovery:**
    1.  In Terminal run `command -v claude` (or `codex`, `agy`, `opencode`) and check the CLI works there.
    2.  Open the agent picker. If the CLI is missing, use **Install** (Claude Code, Codex, Antigravity) and then **Refresh**. OpenCode is installed by hand. See [Agent CLIs](index.md#agent-clis).
    3.  If it works in Terminal but not in Cockpit, quit Cockpit completely (⌘Q) and open it again, so it reads your `PATH` afresh. Do not move or reinstall a working CLI just because detection failed.

**Symptom:** "<Agent> cannot be executed."
*   **Cause:** The file is found but is not executable.
*   **Recovery:** Check its permissions or reinstall it, then **Refresh** in the picker.

**Symptom:** The agent starts but fails with an authentication error, or the picker says "Not signed in" or "Sign-in not confirmed".
*   **Cause:** You are not signed in to that provider, or the session expired.
*   **Recovery:** Use **Sign in** in the picker (Claude Code, Codex). For Antigravity run `agy` once in Terminal, and for OpenCode run `opencode auth login`. Then retry. A CLI that is found but not signed in is not an error by itself, and Cockpit does not sign in for you in the background.

**Symptom:** The agent stops with a quota or billing error.
*   **Cause:** You reached the provider's rate limit or cap.
*   **Recovery:** Cockpit shows the limit and, when the provider reports it, the reset time in the conversation menu. [Switch agents](guide.md#switching-agents) to carry on from the transcript, or wait for the reset.

**Symptom:** Codex says the configured model requires a newer CLI.
*   **Cause:** The Codex CLI is older than the model in your Codex settings. Detection does not prove model compatibility.
*   **Recovery:** Update Codex the way you installed it (for a Homebrew cask, `brew upgrade --cask codex`), or use **Update** in the picker, then check it in Terminal. Or choose another agent. Cockpit does not change your provider configuration.

**Symptom:** A Claude Code launch error mentions an unsupported option, or says it could not check the CLI.
*   **Cause:** The Claude Code CLI does not offer something Cockpit needs, or its `--help` check failed.
*   **Recovery:** Update Claude Code (**Update** in the picker, or your usual method), then **Refresh**. Your conversation is kept. See [compatibility](compatibility.md#claude-code).

**Symptom:** The picker shows "Installed but not usable by Cockpit", or an install or update ended with "Did not finish".
*   **Cause:** The installer failed, was cancelled, or produced a CLI Cockpit cannot drive. The message names the reason, and the output is kept in a log under `<state>/agent-operations`.
*   **Recovery:** Read the message. Run the manual command it shows in Terminal, then **Refresh**. Your conversations are kept.

**Symptom:** The picker says the official installer "has changed since this version of Cockpit was released".
*   **Cause:** The vendor's install script is not the one this Cockpit reviewed, so Cockpit did not run it.
*   **Recovery:** Read it yourself at the address shown. **Install this version anyway** runs exactly the version Cockpit showed, or run the command yourself.

**Symptom:** An update shows "Waiting to update", or "Update waiting for confirmation" after a restart.
*   **Cause:** An update waits until every conversation using that CLI is idle, and new sessions with it wait too. An update that was waiting when you quit never resumes by itself.
*   **Recovery:** Let the conversations finish, or stop them. Choose **Resume update** or **Cancel**.

**Symptom:** "Chrome did not answer within 30 seconds, so Cockpit stopped this turn."
*   **Cause:** **Use my Chrome** could not reach Chrome.
*   **Recovery:** Open Google Chrome, check the Claude extension is installed and signed in to the same account as Claude Code, and send your message again. Or turn off **Use my Chrome** in the picker. Cockpit never closes Chrome.

## Conversations and workflows

**Symptom:** A conversation says "Working" but the agent is not responding.
*   **Cause:** The agent process may have crashed or stalled without a clean exit.
*   **Recovery:** Press **Stop**. It asks the agent to interrupt the turn, and it does not stop the conversation's dev servers (stop those from the Processes page). Wait for a settled status before sending a follow-up. If it stays stuck, keep the conversation and report it.

**Symptom:** A conversation says "Starting" for a long time.
*   **Cause:** The CLI was launched and has not reported back. Cockpit cannot see further into the CLI's startup.
*   **Recovery:** Wait a little. If nothing happens, **Stop**, then check the CLI works in Terminal.

**Symptom:** A conversation is missing from the list, or the start of a reply is missing.
*   **Cause:** Cockpit or the Mac stopped while its files were being written (a crash, a power cut, a full disk), leaving a file under `<state>/threads/<id>/` half-written. Cockpit skips the damaged part: a damaged event line is left out, and a conversation whose `meta.json` cannot be read is left out of the list. Every other conversation stays available. (v0.1.4 and earlier could show an empty list instead.)
*   **Recovery:** Copy the state folder first. Nothing was deleted: the damaged file is still on disk, and `messages.md` beside it is a readable transcript. Started from Terminal, Cockpit names the damaged file once. Restore `meta.json` from a backup, or repair it by hand if you are comfortable with JSON, then reopen Cockpit. Make sure the disk has free space.

**Symptom:** "The agent stopped taking input; that message was not delivered."
*   **Cause:** The agent CLI exited, or stopped reading, just as Cockpit sent a message, an approval or a Stop. Only that one message is lost.
*   **Recovery:** Wait for a settled status and send the message again. Cockpit starts or resumes the session. If it keeps happening, run the CLI in Terminal to see why it exits, and report it with the CLI version.

**Symptom:** A failed turn shows a card with **Retry**.
*   **Recovery:** **Retry** sends the same message and images again, once nothing else is running. **Details** shows the raw error. An error that looks like a network problem links to [Network problems](#network-problems).

**Symptom:** "Memory unavailable", or a malformed memory error.
*   **Cause:** `memory.json`, the memory store, is unreadable. This is separate from a conversation failing to load.
*   **Recovery:** Cockpit keeps its bytes and will not overwrite them. Copy the state folder, then repair `memory.json` or restore it from a backup. Memory has no automatic recovery. A conversation problem is fixed separately (see above).

**Symptom:** The agent waits on an approval you cannot see.
*   **Cause:** The card may be further up the conversation, or the view is out of date.
*   **Recovery:** Scroll to the bottom. If there is no card, reload the window with **View → Reload** (⌘R). A request from a process that has since exited shows as "No longer waiting: that turn has ended."

**Symptom:** A request to start a process, remember something, save a workflow, control another conversation or act in the browser failed with "approval expired" or "denied".
*   **Cause:** Cockpit asks first and the card waits 45 seconds. No answer in time lapses the request, and a Stop, Deny or timeout on a browser action removes its grants for that turn.
*   **Recovery:** Ask the agent to try again and answer the card. **Allow for this session** covers later process starts until the agent's session ends.

**Symptom:** A workflow's schedule stopped running, shows "Schedule paused", or "Needs attention" in the list.
*   **Cause:** A scheduled run failed, was stopped, or could not start (for example, the project folder is gone). Cockpit disables that schedule until you enable it again. Saving the workflow also pauses a schedule. An agent changing a workflow that runs with wider permissions pauses it too.
*   **Recovery:** Open the workflow and read the reason. Fix it, then **Save and enable schedule**. Schedules only run while Cockpit is open, and at most one missed run starts when you reopen it.

**Symptom:** A process shows "Interrupted: Cockpit quit while it ran".
*   **Cause:** The last launch ended while it was running. Cockpit does not restart or signal it.
*   **Recovery:** Choose **Start again** on the Processes page if you want it back. **Clear finished** removes the row.

**Symptom:** After a switch, the handoff review says "The conversation changed since you reviewed the handoff. Review it again before switching." *(in the next release)*
*   **Cause:** Something was added to the conversation after you opened the review. Cockpit only sends what you saw.
*   **Recovery:** Read the new handoff that Cockpit shows and press **Start handoff** again.

**Symptom:** You switched to an agent that is not installed.
*   **Recovery:** Install it from the picker and send your message again. Or switch back to the previous agent: the new handoff carries the whole conversation, including the message the missing agent never received. See [Switching agents](guide.md#switching-agents).

## Files and previews

**Symptom:** A file name shows something like `⟨U+202E⟩`, or Cockpit asks before opening a file.
*   **Cause:** The name has characters that hide or reverse text. Cockpit shows them so the name cannot pass for something else (`Invoice-⟨U+202E⟩fdp.command` is a script, not a PDF). It asks before opening anything macOS would run or install.
*   **Recovery:** Open it only if you know where it came from. Rename it with **⋯ → Rename…** if the characters were not intended.

**Symptom:** A banner says "This file changed on disk since you opened it."
*   **Cause:** Another editor, Git or an agent changed the file after you opened it.
*   **Recovery:** Your draft is kept. Choose **Save mine as a copy** (your draft goes to a new file named "(copy)" and the original shows what is on disk), **Reload from disk** (drops your draft) or **Overwrite with mine**. **Revert**, in the header when you have unsaved changes, drops your draft and reloads the file the same way.

**Symptom:** "This file mixes line endings, so it is read-only here", or "Files over 100 KB are read-only here".
*   **Recovery:** Edit it in another editor. Cockpit keeps the file as it is.

**Symptom:** "Port already in use" when starting a process.
*   **Cause:** An earlier server was not shut down, or something else holds the port.
*   **Recovery:** Check the Processes page and its logs first. Reuse a healthy server or stop only the process you recognise. If another program owns the port, pick another port or find its owner before stopping anything.

**Symptom:** The browser pane shows "This page didn’t load" or "Can’t open that here".
*   **Cause:** The dev server is not up yet, it listens on something other than `localhost` or `127.0.0.1`, or the address is not an http or https page (Cockpit's own address and local files are never opened).
*   **Recovery:** Check the process log on the Processes page. Make sure the app serves on `localhost`, then press **Retry** or **Reload**. A reload note "Cockpit unloaded this page while it was idle" means anything typed on it was not kept.

**Symptom:** The pane lists loaded pages and asks you to close one.
*   **Cause:** Cockpit keeps at most 8 pages loaded.
*   **Recovery:** Press **Close page** on one you are done with. **Discard typing and close** appears when it has unsent input.

**Symptom:** A website in the browser pane keeps asking you to sign in, or shows someone else's account.
*   **Cause:** Website data is kept per project folder, separate from Cockpit and other projects.
*   **Recovery:** Sign in again in that project's pane, or use **Project settings → Clear website data** to start clean.

## Phone access

**Symptom:** **Turn on phone access** fails with a message.
*   **Recovery:** Match the message:
    *   "Tailscale is not installed on this Mac": install Tailscale. Cockpit looks on your `PATH` and in the usual places.
    *   "Tailscale is not connected. Log in from the Tailscale menu.": connect Tailscale on the Mac.
    *   "Tailscale did not report this Mac's name. Turn on MagicDNS for your tailnet.": turn on MagicDNS in the Tailscale admin console.
    *   "Tailscale did not answer. Open the Tailscale menu and check it is connected.": open the Tailscale app and check its network extension is approved. Tailscale's own commands can wait forever when it is not.
    *   "HTTPS on this Mac's Tailscale address already goes to …. Turn that off first.": another `tailscale serve` entry uses the control page's address. Cockpit leaves it alone. Turn that entry off yourself, or use **Try again** after.
    *   "Port 47821 is already in use on this Mac": another program holds Cockpit's phone port, often a second copy of Cockpit.

**Symptom:** The phone cannot load the page.
*   **Cause:** The phone and Mac are not on the same Tailscale network, MagicDNS is not resolving, the Mac is asleep, or Cockpit is closed. Quitting Cockpit closes the phone listener.
*   **Recovery:** Check Tailscale is running and signed in to the same account on both devices, that the Mac is awake and Cockpit is open, and that HTTPS certificates are enabled for your tailnet. A VPN running beside Tailscale can take its routes.

**Symptom:** The phone page says "This Tailscale account is not allowed to use Cockpit", "Open Cockpit at its Tailscale address", or "Phone access requires HTTPS through Tailscale".
*   **Recovery:** Use the exact HTTPS address shown in the Phone access panel, from a phone signed in to the Tailscale account shown there.

**Symptom:** Pairing is refused, or never finishes.
*   **Cause:** The code did not match, you chose **Deny**, or the request expired (after a few minutes).
*   **Recovery:** On the phone choose **Ask my Mac** again, then compare the new 6-digit code and press **Allow** on the Mac. Phone access must be on.

**Symptom:** "This browser sent two Cockpit sign-ins. Clear this site's data in the browser, then pair the phone again."
*   **Cause:** Two device cookies reached Cockpit. That is treated as no sign-in at all.
*   **Recovery:** Clear that site's data in the phone's browser and pair again.

**Symptom:** The phone says "This phone is signed out" or its stream stops.
*   **Cause:** The phone was removed in the Phone access panel, or phone access was turned off.
*   **Recovery:** Pair it again.

**Symptom:** Notifications do not arrive.
*   **Recovery:** Turn them on from the bell on the phone and allow them in the browser. Use **Send a test notification** on the Mac, which tells you if the push service rejected it. Turn them off and on again on the phone if it did. Delivery to real phones is not yet fully verified.

**Symptom:** **Turn off phone access** says Tailscale could not be updated.
*   **Cause:** Phone access is off, but Cockpit could not remove its `tailscale serve` entry (Tailscale was not answering).
*   **Recovery:** Start Tailscale and turn phone access on and off again, or run `tailscale serve status` and remove the entry yourself. Cockpit only removes the entry that points at its own listener.

**Symptom (phone previews, in the next release):** a row says "HTTPS <port> on this Mac already goes to <address>. Cockpit leaves it alone."
*   **Cause:** That preview's port already serves something else. Cockpit never takes over a port.
*   **Recovery:** Stop or move whatever serves it, or ignore it. Cockpit will not change it.

**Symptom (phone previews):** "Phone previews are limited to N apps on this Mac, and every place is assigned." (N is how many places there are, 16 at most)
*   **Cause:** Places are never reused, so an old phone tab cannot reach a different app. Apps whose project was removed keep their place.
*   **Recovery:** There is no way to free a place. Keep previews for the apps you use most.

**Symptom (phone previews):** "Phone preview settings could not be read and were left as they are".
*   **Cause:** `phone-previews.json` in the state folder is damaged. Cockpit assigns nothing new until it is fixed.
*   **Recovery:** Copy the state folder, then repair or restore that file.

**Symptom (phone previews):** the phone's **View app** shows a message instead of the app.
*   **Recovery:** Each message has a fix. See the tables in [Phone live preview](guide.md#phone-live-preview).

## Network problems

Cockpit runs on your Mac and needs no Cockpit server. These things do use the network, and a firewall, VPN, proxy or filtering app (Little Snitch, LuLu, a company network) can block any of them. When an error looks like one of these, Cockpit links here.

**Symptom:** An agent stops with `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, "Connection error" or "fetch failed".
*   **Cause:** The agent CLI cannot reach its provider. Cockpit only starts the CLI. The connection is the CLI's own.
*   **Recovery:** Run the same CLI in Terminal (for example `claude`, then a short message). If it fails there too, the network or provider is the problem: allow the CLI through your firewall or filter, set its proxy as its documentation describes (many read `HTTPS_PROXY`), or try another network. If it works in Terminal but not in Cockpit, a filtering app may treat Cockpit's copy differently. Allow it there too, then quit and reopen Cockpit.

**Symptom:** Check for Updates or **Help → Release Notes** says Cockpit could not reach GitHub, or timed out.
*   **Cause:** `api.github.com` is blocked or slow on this network.
*   **Recovery:** Open https://github.com/Holodeck23/agent-cockpit/releases in your browser. If it loads, allow Cockpit to reach `api.github.com`. If not, check for updates from another network. A failed check never changes your copy of Cockpit.

**Symptom:** Install, update or version check in the agent picker fails.
*   **Cause:** The vendor's install address or the npm registry (`registry.npmjs.org`) is blocked, or the answer was not an install script (a captive portal or error page). Nothing was installed.
*   **Recovery:** Use the manual command the picker shows, from a network that allows it.

**Symptom:** Phone access never connects.
*   **Recovery:** See [Phone access](#phone-access). Tailscale needs its own network access on both devices.

## Cockpit itself

**Symptom:** Cockpit seems to have hit an unexpected error but keeps running. *(In the next release.)*
*   **What happens:** An uncaught error in Cockpit's main process, where its server runs, no longer freezes the window, your phone and every agent session behind an error dialog. Cockpit records it and keeps running. Without this, one dropped phone connection could freeze everything.
*   **Where to look:** `<state>/logs/main-errors.log`, where `<state>` is `~/.agent-cockpit` or the folder in `COCKPIT_HOME`. Each entry has a time, whether it was an uncaught exception or an unhandled rejection, and its stack. A log over 1 MB is moved to `main-errors.log.1` and a new one starts. If Cockpit was started from Terminal, the same line is printed there.
*   **What to do:** If something stopped working, quit and reopen Cockpit. Your conversations are kept. When you report a problem (**Help → Report a Problem…**), attach the log, but remove private paths and project names first. Cockpit does not send it anywhere.

**Symptom:** Cockpit will not quit, or leaves processes behind.
*   **Recovery:** **Quit** (⌘Q) stops every agent session and process Cockpit started, then exits. If a process outlives it, find it with `ps` and stop it, and report it.
