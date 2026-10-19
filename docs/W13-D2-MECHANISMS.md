# W13 remaining mechanism decisions

19 October 2026. Reconciliation from the delivery checkpoint at `51c3071`. The canonical reviewed domino handoff, revision-6 contract and live acceptance ledger in the vault remain authoritative. The narrower delivery proposal has not been approved. A1–A16 remain non-PASS.

## Three remaining families

| Family | Established evidence | Missing mechanism or integration | Release consequence |
| --- | --- | --- | --- |
| Instructions and precedence | Native Claude root/import/nested loading in four real-account/owned-checkout contexts. Same-name collisions can report both values. Native memory and skill proofs keep their recorded scopes. | Global/local/path-conditional rules, external imports and their approval, complete Codex instruction precedence, actual-project comparisons and lifecycle. Preserve source order and conflicts; do not invent deterministic model override semantics. | A13/A15 stay incomplete. The new unconditional project-rule probe is a separate direct-native observation, not packaged qualification. |
| Policy, completion and explicit Stop | Packaged Claude runner handled one synthetic hook's exit failure and internal timeout. Native parent completion and terminal second rejection worked in the recorded contexts. An inert Codex wrapper demonstrated one host batch identity per completion cycle. Pure persisted completion and Stop contracts exist. | A native pre-action enforcement boundary that survives failure of the hook runner itself; authenticated production completion batches and durable recovery; production Stop barrier/deadlines and descendant uncertainty; required context coverage. SubagentStop remains unrun without a human exception. | A6/A11/A12 stay blocked. A callback observation or process snapshot cannot establish prevention of every protected effect. |
| Complete input and recovery | Versioned envelope, exact skill/resource revisions, binding checks, operation comparison and recovery decisions exist as pure contracts. Packaged first-input bridge denial worked. | Production acceptance, idempotency, queues, steering, dispatch, withdrawal and draft recovery still use the older text/image path. Codex production input remains text/images. | A12/A14 stay blocked. A direct typed-skill proof does not establish production queue/recovery behavior. |

Source locations: `scripts/lib/w13-claude-instruction-oracle.ts`, `server/hooks/policy-runner.ts`, `server/agents/claude/hook-sources.ts`, `server/threads/completion-ledger.ts`, `server/threads/stop-contract.ts`, `server/threads/input-envelope.ts`, `server/threads/manager.ts`, `server/agents/codex/launch.ts` and `server/agents/stop.ts`.

## Enforcement design gate

The existing runner converts observed hook failures to a native blocking answer. Its shell tail handles ordinary runner launch/crash exit statuses. Its timeout margin makes an internal timeout answer more likely to arrive before the native timeout. These mechanisms do not establish that the native caller blocks if the shell/runner cannot return an answer, the native hook engine times out, or native parsing/serialization fails.

Read-only recheck of the preserved Codex source at `9e8562b` confirms the mismatch: `hooks/src/events/pre_tool_use.rs` initializes `should_block` false and retains it for execution errors, malformed output, unsupported decisions, ordinary nonzero exits, an exit-2 answer without a reason, and serialization failure. Existing native tests explicitly retain several of these cases as failing open. `core/src/hook_runtime.rs` returns Continue when `should_block` is false, and also when a blocking reason is missing. This is source evidence, not a new live protected-effect reproduction, and it does not identify the bytes of every selectable Codex executable.

Production app-server hook notifications are observations; reacting after a failure notification is not a demonstrated pre-action gate. Current command/file approvals and host bridge grants also do not establish interception of every native tool call. For Claude, the wrapper source itself documents the native nonblocking timeout/error distinction. The earlier packaged failure tests exercise errors inside a functioning wrapper, with narrower scope than the full promise.

The next enforcement design must meet this finite contract before broad production integration:

1. Name every protected operation and the native point that waits before its effect. Cover commands, file changes, reads and connector calls where a selected policy applies. Preserve the complete expected policy inventory; a missing/untrusted expected hook cannot silently mean no policy.
2. Require a current authenticated host allowance bound to operation identity, arguments, provider/session/turn, account/workspace, manifest and authorization generation. No allowance, timeout, malformed answer, missing runner or stale binding must deny at that native waiting point.
3. Evaluate reviewed host-owned policy roles before returning the allowance. Bind the dependency bundle and all completion checks to one persisted batch, rather than counting per-handler IDs or assistant text.
4. Fence dispatch, approvals and grants immediately on explicit Stop/revocation. A late allowance or result cannot remove the fence. Persist completion/Stop decisions and recovery without restarting correction budgets or deadlines after a crash.
5. Demonstrate each failure before a synthetic protected effect, including loss of the outer runner/response and delayed effects. Pair each denial with a successful control. Test without automatic subagents, real credential relocation, installed-app changes or adoption of the experimental provider.

First evaluate a documented supported all-action callback/permission interface against that contract. **Stop that route if any protected action can proceed without its required allowance.** Another supervised wrapper around the same failing-open hook path does not resolve it. If the supported interface cannot meet the contract, present the smallest provider-boundary change and its maintenance/adoption requirements for an explicit scope decision; do not begin a provider rewrite. The previously proposed compatibility contract is a separate human decision, not the fallback result of this design test.

## Ordering and preserved work

Bounded instruction inventory/probes can proceed while enforcement remains unresolved. Production envelope/completion/Stop wiring is still held by the reviewed Domino-2 gate. Once that gate has a supported mechanism or an explicitly revised contract, use the existing manager and the pure contracts above; do not create another status engine.

Do not repeat completed memory, skill, build or main-reconciliation work merely to resume. Keep the exclusive packaged development build and historical failures intact. Final cumulative, shipping, installed, human and independent-device qualification remain separate required work. No installer readiness follows from this reconciliation.
