# Next plans: runbook

Two planned pieces of work, written so an agent can execute them without asking questions:

| Plan | What it delivers |
|---|---|
| [turn-quality.md](turn-quality.md) | No dead turns (an agent that stops silently after a blocked step gets one visible follow-up) and a per-agent turn report |
| [projects-area.md](projects-area.md) | The Projects area: tabs you can close, drag and colour; a sidebar; a Map of every project; library folders; agent-OS layers; "Mac only" privacy |

Each plan lists moves in order. Every move says what to do, what you should see, the likely failure and its fix, and when to stop.

## Where each move can run

Cockpit is a macOS Electron app. Some checks need the Mac; most of the work does not.

| Work | Cloud agent (Linux, repo only) | Mac session |
|---|---|---|
| Code, unit tests, typecheck, web + Electron builds | Yes | Yes |
| Writing packaged proof scripts | Yes (write, do not run) | Yes |
| Running packaged proofs (`npm run package:proof`, `proof:*`) | No | Yes |
| Live agent runs (Claude Code, Codex, Antigravity) | No | Yes |
| Running the turn report on real conversation data | No | Yes |
| Scanning a person's real library folders | No | Yes |
| Approving the Projects-area mockup | No (a person decides) | — |

GitHub CI runs `check:paths`, typecheck, tests and both builds on macOS for every pull request. That CI result is the authoritative check for cloud work.

## Cloud agent setup

```sh
git fetch origin
# Base: main if it already contains the v0.1.8 candidate, else the candidate itself.
if git merge-base --is-ancestor 4d80d8e origin/main; then BASE=origin/main; else BASE=origin/release/v0.1.8; fi
git switch -c feat/turn-quality "$BASE"     # or feat/projects-area-<move>
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm ci
npm run typecheck
```

Node 22. Do not run `npm run package` or `npm run release` in the cloud.

**Linux test baseline (do this first).** The suite is maintained on macOS. Before changing anything, run `npx vitest run` on the untouched base and save the list of failing test files to the PR description as "pre-existing on Linux". From then on, only a NEW failure counts as a regression. If more than 10 test files fail on the untouched base, stop and report; the environment is wrong.

## Rules for every move

- One branch per plan section, commit and push after every move. Open a draft pull request after the first move and keep it updated.
- This repository is public. Never commit absolute home paths (`npm run check:paths` enforces it), personal folder names, real project or client names, or screenshots of real data. Fixtures use temp directories and invented names.
- Never add a field to `projects.json` (see projects-area.md, "Why navigation.json").
- Never give any element outside the project tab bar `role="tab"` (see projects-area.md, "Proof constraints").
- Stop at a plan's abort conditions and report; do not improvise around them.

## Order

1. **Cloud session 1:** turn-quality Moves 1–4 (code + unit tests); projects-area Move 1 (mockup, committed as a static file) and Moves 2, 3, 4, 9 (no design dependency). Stop. Report the draft PRs and the mockup path.
2. **Person:** approves or changes the mockup.
3. **Cloud session 2:** projects-area Moves 5–8 and 10.
4. **Mac session:** every packaged proof and live check in both plans' Verification sections, the turn-report baseline and after-run, then merge.
