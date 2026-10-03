# Cockpit prerelease landing page

`index.html` is the complete, self-contained v0.1.3 landing page. It includes inline styles, script, the Cockpit mark and four embedded screenshots from the packaged app. Open it directly from disk or host this directory as a static website. Outbound links point to the public repository, release asset, issues and Enjoy attribution.

The embedded interactions are explicitly labeled simulations. They do not invoke agents, execute commands, access app state, call APIs or consume provider usage. Screenshot viewing, the gallery, preview scenes and FAQ work offline. Download and external links require a connection.

When served over http(s) from a non-local host, the page loads Vercel Web Analytics (`/_vercel/insights/script.js`, cookieless page views). Opened from disk or localhost it loads nothing. DMG downloads are counted by GitHub: `gh api repos/Holodeck23/agent-cockpit/releases -q '.[].assets[]|.name+" "+(.download_count|tostring)'`.

Hosted on Vercel as project `agent-cockpit`: https://agent-cockpit-theta.vercel.app (`agent-cockpit.vercel.app` is someone else's site). Deploy the existing project with `vercel deploy landing --prod --yes --project prj_UW9WKWGF9SHNckMf2FiqLNpGiHtZ --scope davids-projects-3fd8f18a` from the repository root. `.vercelignore` restricts uploads to the static page. This is a CLI deployment; the Vercel project is not connected to Git.

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
- Release asset: `Cockpit-0.1.3-arm64.dmg` from tag `v0.1.3`.
- Suitable portfolio card title: **Cockpit**.
- Label: **Mac app · prerelease**.
- Suggested description: **A desktop workspace for coding agents, with recent-work recovery, inline approvals, embedded preview inspection, project files and repeatable workflows.**
- Card CTA: **Explore Cockpit** → https://agent-cockpit-theta.vercel.app.
- The portfolio itself has not been changed. The canonical site is the Vercel URL above; this folder is its source.

Page claims are grounded in the release API response, README, release acceptance checklist, component source, and packaged-app captures. The original recon, release metadata, installed-DMG verification, timing evidence and page checks are kept in the maintainer's private release archive, not in this repository.
