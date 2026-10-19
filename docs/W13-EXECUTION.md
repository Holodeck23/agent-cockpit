# W13 execution authority

Current first-release authority: the canonical project document `2026-10-19-w13-compatibility-release-CONTRACT.md` in the vault, approved after the human's plain-language scope discussion. [Supported boundary and fixed blockers](W13-COMPATIBILITY-RELEASE.md) summarize it. The stronger revision-6 requirements remain preserved; no original A1–A16 row becomes PASS through deferral. The prior Domino-2 production-integration hold and pending-scope question are superseded for this compatibility release.
Historical ordering and full-contract choices: canonical `2026-10-18-w13-reviewed-domino-handoff.md` and `2026-10-16-w13-effective-setup-PLAN.md`. Retained privacy, account, startup, recovery, Stop and release obligations still apply as mapped by the new contract.
Live checkpoint ledger: the canonical project document `2026-10-18-w13-acceptance-ledger.md` in the vault.

Domino 1 preserved the unique pre-repair proof under `release.noindex/preserved/w13-pre-domino-1-779b5163df92`. Its receipts remain historical; no qualification transfers. Main's landing changes were reconciled through `fe7274c`; do not repeat that merge. Historical U0/U1 continuation instructions and release-acceptance status describe their original builds only.

## Compatibility implementation checkpoint — 19 October 2026

`de4a7cc` implements stock Codex authenticated first-input readiness and recoverable startup input, including final-withdrawal working-state cleanup. Full source verification passed2208 tests/347 files and both builds. The new development proof passed three background synthetic scenarios: authenticated dispatch, missing-bridge restore-to-draft, Stop with late authentication and no replay. No real provider/model call was used.

The latest exclusive proof is `release.noindex/w13-compatibility-20261019/attempt-02/proof/mac-arm64/Cockpit.app`, asar `37b85ade57feb679a41c60bcc65493a11de02da6cb2eb36294b47abfa261974d`. It also corrects the bridge-error heading and repeats all three packaged scenarios with an explicit title assertion. Its four backend bundles are byte-equal to the first proof; the changed UI/error classifier passed52 focused error/transcript checks, typecheck and web build. Evidence is in canonical vault output `agent-cockpit/2026-10-19-w13-compatibility-release/`. These are development observations, not release qualification; C1 remains open for inherited native executable startup. C2-C8 also remain open.

## Historical full-contract mechanism reconciliation — 19 October 2026

[Three remaining families and the finite enforcement design gate](W13-D2-MECHANISMS.md): instruction precedence/inventory; policy/completion/Stop; complete production input/recovery. The original contract still applies. Broad production wiring remains held until the native pre-action enforcement boundary is demonstrated or the human explicitly revises the contract. Another wrapper around a failing-open native hook path is insufficient.

The subsequent bounded supported-interface audit found a concrete native Codex resource-read path that proceeds after hook failures without host permission. That route is stopped; do not repeat wrapper/permission-option experiments on it. The mechanism document now contains the source trace and a minimal opt-in native enforcement scope proposal. A human scope decision is pending: separately authorize native-boundary feasibility while retaining full W13, or explicitly approve the already proposed compatibility contract. Neither has been inferred. No provider source or production runtime changed.

New bounded direct-native evidence: all four default/managed Claude × owned primary/linked-worktree cases observed root/import/nested instructions and both unconditional project-rule files, matched five source-only words, excluded the sibling canary and exited. Both managed cases reported both conflicting values; neither the harness nor the report claims deterministic collision precedence. 46 focused tests pass. This extends the earlier loading proof; global/local/path-conditional rules, Codex instruction precedence and production lifecycle still remain open. Evidence is in the canonical vault's existing W13 evidence tree under `domino-2-claude-project-rules`; raw account/provider records stay private. No production runtime or app bytes changed and no acceptance row closes.

## Packaged delivery checkpoint — 19 October 2026

Runtime source `2be1defdb2a7bcd4ef7627bf1dafd79101aa5756` is pushed to `codex/w13-catchup`. The only new verification change serializes test files; assertions, test selection and provider deadlines are unchanged. The original four-worker run failed 10 tests; all 74 tests in its seven failing files passed serially. Full verification then passed all 2192 tests in 346 files, TypeScript, public paths, and web/Electron builds.

Fresh development package: `release.noindex/w13-delivery-20261019/attempt-01/proof/mac-arm64/Cockpit.app`. Asar SHA256: `19b095ac53b9a597d2e6daf7af9c0707a0b4a85e0520515ad823dd50a8b61da6`.

- Packaged setup UI: 17 checks passed, including changed-source review, linked/plugin/project skill selections, off controls and narrow layout.
- Existing managed Claude account, synthetic selections and disposable project: memory/skill initial, later, restarted/resumed and compacted continuity plus deletion cleanup passed 15 checks. Native identity matched before and after restart.
- Reviewed SessionStart hook: 8 checks passed. Approved synthetic connector call: 7 checks passed.
- Policy hook: 9 checks passed, including allowed write, failed-hook denial, timed-out-hook denial and waiting past the delayed allowance.
- Missing bridge: first input stayed undelivered and never reached the fixture provider.

Evidence: canonical vault output `agent-cockpit/2026-10-19-w13-packaged-delivery/`. Raw provider/account records remain only in the approved private client evidence tree. Installed and preserved-proof asar bytes remain unchanged; no package main process remained at closeout. Inline review only.

This is one development checkpoint, not the frozen cumulative release gate or full W13 parity. The new package uses the standard pinned Claude CLI, not the experimental Codex memory extension. Original A1–A16 remain non-PASS. Proposed first-release deferrals in the vault delivery plan have not silently replaced the full acceptance contract.

## Resume

Read the active canonical project `HANDOVER.md`, the compatibility contract and fixed C1–C8 blockers. Continue authorized production integration without requesting another architecture decision. Next: retained Codex executable-startup controls and source review/refusal. Do not rerun the completed readiness/classification unit simply to resume. Preserve completed native memory/skill proofs and the separate Codex extension. Any change to runtime or qualifying inputs invalidates affected evidence.

Use the existing W13 worktree; one owner/unit, no automatic agents. Preserve concurrent work. Request installation approval for concrete qualified bytes. No publication, deployment or EA submission. Local binaries and private evidence do not travel with the public branch; use local continuation.
