# CLI protocol notes

What it takes to drive the supported CLIs headless from another app. Everything here was verified by running the real CLIs, and most of it is not obvious from the docs. Recorded wire traffic lives in `tests/fixtures/` and the parsers are tested against it.

## Claude Code (`claude -p`)

Cockpit keeps one long-lived process per conversation:

```
claude --print --verbose --input-format stream-json --output-format stream-json --include-partial-messages
       --permission-mode <mode> --permission-prompts host --permission-prompt-tool stdio
       --strict-mcp-config --mcp-config <json> --settings <json>
       [--session-id <uuid> | --resume <uuid>] [--model] [--effort] [--allowedTools] [--append-system-prompt]
```

Each user message is one JSON line on stdin; events come back one JSON line each on stdout. Built from a schema in `server/agents/claude/flags.ts`, so nothing raw from the UI ever reaches argv.

- **Approval routing is capability-aware.** Each new Claude process is preceded by a bounded `--help` probe of the same selected executable. Send `--permission-prompts host` only when advertised; always retain `--permission-prompt-tool stdio` and the selected permission mode. The latter is a hidden SDK option in the tested CLIs. The original observation was that `--permission-prompts host` alone did not route approvals over stdio; that does not mean older CLIs require that newer flag. Real Deny, Allow and native-resume behavior is tested separately from help parsing. Probe failure or missing required advertised options/choices ends the turn with actionable guidance without launching the provider or marking a session resumable. There is no persistent success cache or automatic CLI upgrade.
- **A request** arrives as `control_request{request:{subtype:"can_use_tool", tool_name, input, permission_suggestions}}`. **The answer** is `control_response{response:{subtype:"success", request_id, response:{behavior, updatedInput | message}}}`.
- **Approving must echo the original input** as `updatedInput`. An empty object replaces the tool's input with nothing.
- **Allow for this session** is `updatedPermissions: permission_suggestions` alongside the allow.
- **Hook settings merge across sources.** `--settings '{"hooks":{"SessionStart":[]}}'` does not silence hooks defined elsewhere. Only `disableAllHooks: true` turns them off, which is why cockpit threads default to it (a thread can opt back in).
- **Interrupt** is a `control_request{subtype:"interrupt"}`. The turn then ends with a failed `result`, which Cockpit records as stopped rather than as an error.
- **Stopping the process**: close stdin and it saves its session and exits. Mid-turn it may not, so Cockpit follows with SIGTERM after 1.5 s and SIGKILL after 3 s (`server/agents/stop.ts`).
- **Resume across processes** works with `--session-id` on the first run and `--resume` on later ones.
- `rate_limit_event` carries the five-hour limit status and `resetsAt`, shown in the conversation menu.
- **stdio MCP servers inherit the agent's environment.** Cockpit relies on this to hand each session's MCP token to the MCP process without putting it in argv or in the config JSON.

## Codex (`codex app-server`)

JSON-RPC over stdio, without the `jsonrpc` field.

- **Handshake**: `initialize`, then the `initialized` notification, then `thread/start` (or `thread/resume {threadId}`), then `turn/start` per message. Codex assigns its own thread id; Cockpit adopts it from the start response and resumes with it next time.
- **Approvals** arrive as server requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) and are answered with `{decision: accept | acceptForSession | decline}`.
- **MCP tool approvals** arrive differently: as an MCP elicitation, `mcpServer/elicitation/request {serverName, message, ...}`, answered with `{action: accept | decline | cancel, content, _meta}`. Cockpit shows both kinds as the same approval card.
- **Permission modes** map to approval policy plus sandbox: manual and acceptEdits to on-request + workspace-write, plan to read-only, auto and dontAsk to never + workspace-write, bypassPermissions to never + danger-full-access.
- **MCP servers** are configured per launch with `-c` overrides, whose values are parsed as TOML:
  ```
  -c mcp_servers.cockpit.command="..."            -c mcp_servers.cockpit.args=["..."]
  -c mcp_servers.cockpit.env={"ELECTRON_RUN_AS_NODE"="1"}
  -c mcp_servers.cockpit.env_vars=["COCKPIT_MCP_URL","COCKPIT_MCP_TOKEN"]
  -c mcp_servers.cockpit.tools.list_processes.approval_mode="approve"
  ```
  Unlike Claude, Codex does **not** pass its own environment to MCP servers. Only variables named in `env_vars` are forwarded.
- **MCP tool calls** show up as `mcpToolCall` items with `server`, `tool`, `arguments`, `result` and `error`. Cockpit names them `mcp__server__tool`, the same as Claude, so the UI treats both alike.
- `turn/completed` with status `interrupted` is a stop; `error` notifications with `willRetry: true` are noise.
- If `~/.codex/config.toml` pins a model newer than the installed CLI supports, every turn fails with a 400. Set a model on the conversation, or upgrade the CLI.
- `codex app-server generate-ts --out <dir>` prints TypeScript types for the whole protocol. It's the fastest way to check a field name.

## Antigravity (`agy`)

Cockpit keeps one `agy` print-mode process alive per open session:

```
agy --input-format stream-json --output-format stream-json --disable-slash-commands
    [--model <slug>] [--effort low|medium|high] [--conversation <uuid>]
    [--mode plan | --dangerously-skip-permissions]
```

- First run emits `init` with a `conversation_id`; later processes resume it with `--conversation`. A real two-process run against the user's cached Google/Antigravity subscription recovered prior context.
- Each stdin line is `{ "event":"user", "message": { "content":"..." } }`. Stdout carries `init`, `step_update` and terminal `result` objects. Agent response deltas render live; `result.response` becomes the persisted assistant message.
- Tool steps arrive as `ACTIVE`, then `DONE` or `ERROR`, with parameters and output under `tool_info`. Cockpit uses conversation id plus step index as the stable activity id.
- The CLI accepts only low, medium and high effort. Cockpit's shared xhigh/max choices clamp to high rather than sending an invalid flag.
- **Headless approvals are policy-only.** The CLI cannot pause and send a permission request to the host. Its default policy permits workspace file operations and soft-denies shell actions that need review; auto-like Cockpit modes use `--dangerously-skip-permissions`, and Plan uses `--mode plan`. The picker states this limitation.
- Authentication is cached by `agy`; the adapter never receives a key. The Gemini CLI personal tier returned `UNSUPPORTED_CLIENT`, while `agy` 1.2.14 reused the same user's subscription successfully.
- Antigravity's global/workspace MCP configuration has no per-launch config flag. Cockpit does not mutate a user's global or project MCP files, so its session-scoped MCP tools are not attached to Antigravity yet.

## Switching agents

`POST /api/threads/:id/agent` closes the current session, appends an `agent_switch` event, and gives the thread a fresh session id. The next message starts a new session seeded with the transcript so far (`server/threads/handoff.ts`): `--append-system-prompt` for Claude, `developerInstructions` for Codex. Provider-side history isn't transferred. The files on disk are the handoff.

## Electron

- **A Finder or Dock launch gets launchd's bare PATH**, so `claude`, `codex`, `npm` and `node` may not be found. The app reads macOS's system path list directly and merges Homebrew and common user-level install folders (`electron/shell-path.ts`); it never starts an interactive shell or sources `.zshrc`.
- **The app binary doubles as Node.** With `ELECTRON_RUN_AS_NODE=1`, `Cockpit.app/Contents/MacOS/Cockpit script.cjs` runs a script as plain Node 24, including one inside `app.asar`. That is how the cockpit MCP server runs without Node installed.
- npm 11 can block install scripts, and Electron 44 fetches its binary lazily: run `node node_modules/electron/install.js` once after `npm install`.
