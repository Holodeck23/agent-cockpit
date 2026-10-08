# Cockpit beta terms

Version 1 · 2026-10-08

Cockpit is in beta. You can use the beta on one condition: **Cockpit sends crash and error reports to its developer.** That is how problems in the beta get found and fixed, including the ones nobody reports. You accept these terms when you install Cockpit from Terminal (by typing `agree`) or, if you installed it another way, when Cockpit first opens (**Agree and continue**). If you do not accept them, Cockpit does not install or does not open.

## What is sent

When something goes wrong in Cockpit, a report is sent with:

- the error message and its stack trace (where in Cockpit's code it happened);
- Cockpit's version;
- the macOS version and the kind of Mac (processor and memory).

Cockpit also sends a short record when it starts and stops, so the developer can see how many people run each version and how often it crashes.

## What is not sent

- Your home folder is replaced with `~` in every report.
- Your machine name and macOS user are never sent.
- Screenshots, screen recordings, crash memory dumps and attachments are never sent.
- Your conversations, prompts and the contents of your files are never sent on purpose. The text of an error can still name a project, a file or a folder inside your home folder.

## Where it goes

Reports go to [Sentry](https://sentry.io), in its EU region, in a project only the developer can see. Sentry deletes them after its retention period. The project is set not to store IP addresses.

## Turning it off

There is no setting to turn reports off during the beta. To stop them, quit Cockpit and delete it from Applications. Nothing is sent while Cockpit is not running.

## Questions and deletion

Ask the developer, David Di Lallo, in the Early AI-dopters community on Skool, or open an issue on [GitHub](https://github.com/Holodeck23/agent-cockpit/issues). Reports carry no name, account or machine name, so they cannot be traced back to you or picked out as yours.

## Changes

If these terms change, the version above goes up and Cockpit asks you to accept the new version before it opens again.
