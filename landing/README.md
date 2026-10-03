# Cockpit prerelease landing page

`index.html` is the complete, self-contained v0.1.4 landing page. It includes inline styles, script, the Cockpit mark and four embedded screenshots from the packaged app. Open it directly from disk or host this directory as a static website. Outbound links point to the public repository, release asset, issues and Enjoy attribution.

The embedded workspace is explicitly labeled as a simulation. Resume the sample project, allow or deny startup, use the focus counter in the preview, switch agents, and move between conversations. Files lets visitors edit and explicitly save sample notes; Workflows reads the saved version and shows a fixed review checklist. State survives view changes and resets on Reset preview or reload. There is no provider call, backend, real command execution or model usage.

Screenshot viewing, embedded Fraunces fonts, the workspace and FAQ work offline. Download and external links require a connection. Fraunces is distributed under the SIL Open Font License 1.1; its copyright notice and complete license are included in the HTML.

When served over http(s) from a non-local host, the page loads Vercel Web Analytics (`/_vercel/insights/script.js`, cookieless page views). Opened from disk or localhost it loads nothing. DMG downloads are counted by GitHub: `gh api repos/Holodeck23/agent-cockpit/releases -q '.[].assets[]|.name+" "+(.download_count|tostring)'`.

Hosted on Vercel as project `agent-cockpit`: https://agent-cockpit-theta.vercel.app (`agent-cockpit.vercel.app` is someone else's site). Deploy the existing project with `vercel deploy landing --prod --yes --project prj_UW9WKWGF9SHNckMf2FiqLNpGiHtZ --scope davids-projects-3fd8f18a` from the repository root. `.vercelignore` restricts uploads to the static page. This is a CLI deployment; the Vercel project is not connected to Git.

The page uses an editorial type system and cobalt stage around a sample workspace grounded in the product UI. This brief requests one landing page with an embedded demo, not a separate demo route.

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

`check-render.mjs` checks computed contrast, specificity collisions and horizontal overflow. `verify.mjs` checks the complete visitor journey at 360, 390, 768 and 1280px: recovery, approval and denial, counter state, handoff, explicit note saving, workflow use of saved notes, safe text rendering, reset, gallery, dialog, FAQ and release navigation. It checks zero external requests offline and no JavaScript exceptions. To save screenshots, supply an output directory.

Set `LANDING_URL` to repeat the same full journey against the HTTP preview or deployed URL. Local passing checks do not establish that the production site is current or usable; exercise the actual delivery URL after publishing and visually inspect the result. Also review every element that looks actionable, not only elements already covered by the test.

## Release / portfolio handoff

- Static publish root: `landing/`. Entry: `index.html`. No build command.
- Release asset: `Cockpit-0.1.4-arm64.dmg` from tag `v0.1.4`.
- Suitable portfolio card title: **Cockpit**.
- Label: **Mac app · prerelease**.
- Suggested description: **A desktop workspace for coding agents, with recent-work recovery, inline approvals, embedded preview inspection, project files and repeatable workflows.**
- Card CTA: **Explore Cockpit** → https://agent-cockpit-theta.vercel.app.
- The portfolio itself has not been changed. The canonical site is the Vercel URL above; this folder is its source.

Page claims are grounded in the release API response, README, release acceptance checklist, component source, and packaged-app captures. The original recon, release metadata, installed-DMG verification, timing evidence and page checks are kept in the maintainer's private release archive, not in this repository.
