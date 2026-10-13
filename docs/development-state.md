# Development preview state

`npm run dev:server` uses a stable profile for the current real checkout under
`~/.agent-cockpit-dev/`. It ignores an inherited desktop `COCKPIT_HOME`, so starting
Cockpit's own preview cannot recover or rewrite its parent's live conversations.
An empty development profile starts with its own project and conversation list.

Set `COCKPIT_DEV_HOME` to choose a development profile explicitly. Point it at a
different folder from the desktop profile; the development entry point rejects
the same existing folder, including a symbolic-link alias.

`npm start` retains its existing `COCKPIT_HOME` / `~/.agent-cockpit` behavior.
For direct development launches use `tsx server/index.ts --development`.
