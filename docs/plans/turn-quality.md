# Plan: turn quality (no dead turns + turn report)

Runbook and environment: [README.md](README.md).

## Why

A turn that does work and then says nothing reads as finished. Measured on real conversations, live in Cockpit:

- **Only Antigravity goes silent.** Most silent Antigravity turns end at the moment its own permission policy refuses a step. Claude Code and Codex end with a reply.
- **The "end with a final message" guidance often never reaches Antigravity.** `TURN_GUIDANCE` (`server/threads/turns.ts`) is only sent inside `COCKPIT_GUIDANCE` (`server/mcp/sessions.ts`), and `instructionsFor` (`server/threads/manager.ts`) adds that only when Cockpit's tools are attached. Antigravity gets them only in projects opted into Cockpit tools.
- **Imported sessions distort counts.** `withTurnEnds` in `server/import/sessions.ts` adds a successful `result` before every later message of an imported session, with no marker. A Codex-app session where the person typed mid-turn looks like a run of silent Codex turns.

### Antigravity behaviour, tested (agy 1.3.3, headless stream-json, default permissions)

1. Asked to run `find . -maxdepth 1 -type f`, with and without an instruction to explain refusals, agy ran `run_command`, got `TOOL_ERROR permission check failed for unsandboxed "find . -maxdepth 1 -type f"`, and ended the turn: `{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}`. stderr: `no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>))`. **The instruction made no difference: agy ends the turn itself at the first denial.**
2. A second message in the same process ("Cockpit note: your last step (...) was blocked by this conversation's permission mode, not by the user. Without running any more tools, tell the user in two sentences what you were trying to do, what was blocked, and what you can say without it.") got a real reply and no tool calls. **A follow-up works.**
3. The second turn's `result` still listed the first turn's `denied_actions`. **The field is cumulative for the session.** Never detect a refusal from it alone.

## Moves

### Move 0: base and baseline
- **Do**: set up per README (base branch, `npm ci`, Linux test baseline). Branch `feat/turn-quality`. Check `grep -n "TURN_GUIDANCE" server/mcp/sessions.ts` and `grep -n "denied_actions" server/agents/antigravity/parse.ts`.
- **Expect**: TURN_GUIDANCE still inside COCKPIT_GUIDANCE; no `denied_actions` handling.
- **Fork**: if `denied_actions` is already parsed, skip Move 3 and reuse what exists.

### Move 1: turn report (measure before changing behaviour)
- **Do**:
  1. `server/import/sessions.ts` `withTurnEnds`: add `synthetic: true` to both results it creates; add `synthetic?: true` to the `result` variant in `server/agents/types.ts`.
  2. New pure module `server/threads/turn-outcomes.ts`: `turnOutcomes(events)` → one row per turn (from a `user_text` to the next `result | exit | error | agent_switch | session_boundary`): `agent`, `startedAt`, `outcome`, `tools`, `tokensIn?` (from an Antigravity `usage` event with `limitType: 'last_turn'`, parsing `"… tokens (N in, …"`), `durationMs?`, `imported`. `imported` = closing result has `synthetic`, or it has the same `ts` as the next `user_text` and no `durationMs` and no `runId`. Outcome, first match wins: `stopped` → `failed` (`ok:false`) → `question` / `blocked` (`parseConclusion` on the last assistant text) → `concluded` (last of tool_use/assistant_text is a non-empty assistant_text) → `recovered` (silent, and the next turn is a `fromCockpit` follow-up that concluded; Move 4) → `silent_after_refusal` (a tool result in this turn is a refusal) → `silent`.
  3. `scripts/report-turns.ts`, npm script `report:turns`: reads `$COCKPIT_HOME` (default `~/.agent-cockpit`) `threads/*/events.jsonl` + `meta.json`, excludes imported turns, prints one row per agent: turns, concluded %, question, blocked, silent_after_refusal, recovered, silent, stopped, failed, median tokensIn, median durationMs. `--json` prints rows.
  4. `tests/turn-outcomes.test.ts`: one fixture per outcome, plus an imported fixture that must be excluded.
- **Expect**: the new tests pass; `npm run report:turns` against a fixture `COCKPIT_HOME` in a temp dir prints the table.
- **Most likely failure**: imported turns still counted. Cause: timestamps differ by a few ms. Counter: the `no durationMs and no runId and followed by user_text` rule.
- **Mac session (later)**: run `npm run report:turns` on real data BEFORE installing any build with Moves 2–4, save it privately as the baseline.

### Move 2: guidance reaches every agent
- **Do**: remove `TURN_GUIDANCE` from the `COCKPIT_GUIDANCE` array; `instructionsFor` returns `[TURN_GUIDANCE, cockpit ? COCKPIT_GUIDANCE : undefined, project instructions block, seed]`. Do not add an Antigravity "explain refusals" line: test 1 above shows it has no effect.
- **Expect**: tests (find them with `grep -rln "instructionsFor" tests`) assert, for each agent with and without Cockpit tools, that instructions contain `Cockpit shows each turn as an acknowledgement`.
- **Most likely failure**: a test expecting `undefined` instructions for a bare launch. Counter: it now expects exactly `TURN_GUIDANCE`.

### Move 3: Antigravity reports refusals as data
- **Do**: `server/agents/antigravity/parse.ts`: read `result.denied_actions` (`z.array(z.looseObject({ action: z.string(), display_name: z.string().optional() })).optional()`), emit `denied: [{ action, label }]` on the `result` event; add `denied?: readonly { action: string; label?: string }[]` to the result type. Keep `ok: true` (agy reports success).
- **Expect**: a parse test using the exact `result` line from test 1 yields `{ kind:'result', ok:true, denied:[{ action:'command', label:'RunCommand' }] }` and no assistant text.

### Move 4: one visible follow-up
- **Do**:
  1. Move the refusal test used by `web/src/transcript.ts` (the tool-result check documented as "A tool result that says you (or the agent's own permission policy) refused the call") into shared `server/threads/refusals.ts`; import it from the web transcript and the server.
  2. `user_text` gains `fromCockpit?: 'refused-step'` beside `fromConversation` in `server/agents/types.ts`.
  3. In the manager's result handling (`grep -n "incoming.kind === 'result'" server/threads/manager.ts`): when ALL hold, send one follow-up through the normal send path with `fromCockpit: 'refused-step'`:
     - agent is `antigravity` and the per-agent setting is on (default on for Antigravity, off for others);
     - the result's text is empty and the turn has no non-empty `assistant_text`;
     - a tool result in this turn is a refusal;
     - the turn's own `user_text` is not `fromCockpit`;
     - the turn was not stopped and no queued message is waiting.

     Text: `Cockpit note: your last step (<refused step label>) was blocked by this conversation's permission mode (<mode label>), not by the user. Without running any more tools, tell the user in two or three sentences what you were trying to do, what was blocked, and what you can say without it.`
  4. Setting stored the way other per-agent settings are (`grep -rn "useHooks" server web/src | head` shows the pattern). Label: "When a step is blocked, ask the agent to report anyway".
  5. Transcript: a `fromCockpit` message renders as a quiet note ("Cockpit asked Antigravity to report after a blocked step"), never as the person's message. The existing refused-turn error note is not shown when a recovered reply follows.
- **Expect**: manager tests with a stand-in Antigravity session (`grep -rln "stand-in\|standIn\|fake" tests | head` to find the harness): refused silent turn → exactly one follow-up; the follow-up's own silent end → no second follow-up; after Stop → none; with a queued message → none; setting off → none.
- **Most likely failure**: a loop of follow-ups. Cause: the `fromCockpit` guard missing. Counter: that guard and its test exist before any live run.

### Move 5: verify and measure (Mac session)
- **Do**: the Verification list below; after a week of normal use, `npm run report:turns` again and compare with the baseline in the PR.

## Abort conditions

- More than one follow-up for one person's message, in any test or run: stop, revert Move 4.
- A follow-up turn runs any tool: stop, tighten the wording, re-test.
- A new failing test file outside this plan's files (compared with the Linux baseline, or on macOS CI): stop and report.
- Any storage change beyond the optional fields named here: stop.

## Verification

1. Each move: `npm run typecheck && npx vitest run <the move's test files>` green.
2. Each push: macOS CI green on the pull request.
3. Mac, live Antigravity, Manual mode, a scratch project: "Run `find . -maxdepth 1 -type f` and tell me what it printed". Pass: blocked step, one Cockpit note, a 2–3 sentence reply, no second note; `report:turns` counts it `recovered`.
4. Mac, live Claude Code and Codex, Cockpit tools off, one turn each: both end with a final message.
5. Mac, `npm run package:proof`, wait about 30 s for macOS's malware scanner to go quiet, then `proof:states`, `proof:wave-1`, `proof:handoff` once each: green.

## Red-team record

- Failed attack: "Instruct agy to explain refusals; no follow-up needed." Test 1: it still ends at the denial with an empty response.
- Landed attack: "Detect refusals from `denied_actions`." The field is cumulative (test 3), so every later turn would look refused. Patch: Move 4 keys on empty response + a refusal in this turn + the `fromCockpit` guard.
- Landed attack: "Measure afterwards." Without a baseline nothing is provable. Patch: the report is Move 1 and the baseline is taken before any behaviour change is installed.
