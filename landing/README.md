# Cockpit prerelease landing page

`index.html` is the complete, self-contained v0.1.0 landing page. It includes inline styles, script, the Cockpit mark and two embedded screenshots from the packaged app. Open it directly from disk or host this directory as a static website. Outbound links point to the public repository, release asset, issues and Enjoy attribution.

The embedded interactions are explicitly labeled simulations. They do not invoke agents, execute commands, access app state, call APIs or consume provider usage. Screenshot viewing, the gallery, preview scenes and FAQ work offline. Download and external links require a connection.

This landing page follows the product visual system. Its structure was adapted from the demo-artifact scaffold. Unlike the broader project-to-portfolio workflow, this brief explicitly requests a landing page only, not a standalone demo.

## Preview

From the repository root:

```sh
python3 -m http.server 4388 --bind 127.0.0.1 --directory landing
```

Open http://127.0.0.1:4388. No app server or agent credentials are required.

## Validate

Uses the repo's `playwright-core` dependency and an existing Chrome installation, matching the product's UI proof scripts. Does not use provider allowances.

```sh
node landing/check-render.mjs landing/index.html --width 390,768,1280
node landing/verify.mjs
```

`check-render.mjs` is adapted from the project-to-portfolio skill: computed contrast, specificity collisions, and horizontal overflow. `verify.mjs` checks interactions and offline resource loading. To save screenshots, supply an output directory. Set `LANDING_URL` to also check an HTTP preview.

## Release / portfolio handoff

- Static publish root: `landing/`. Entry: `index.html`. No build command.
- Release asset: `Cockpit-0.1.0-arm64.dmg` from tag `v0.1.0`.
- Suitable portfolio card title: **Cockpit**.
- Label: **Mac app · prerelease**.
- Suggested description: **A desktop workspace for Claude Code and Codex, with parallel conversations, inline approvals, agent handoff, project files and repeatable workflows.**
- Card CTA: **Explore Cockpit** → the eventual published landing URL.
- The portfolio itself has not been changed. Link to this page after its hosting destination is selected; keep one canonical source here.

Page claims are grounded in the release API response, README, release acceptance checklist, component source, and packaged-app captures. Recon, release metadata and render evidence are stored at `/Users/zod/vault/projects/agent-cockpit/release-landing/`.
