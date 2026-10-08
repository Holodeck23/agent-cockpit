# Cockpit landing page

`index.html` is the self-contained release landing page, including the interactive demo,
inline styles/scripts, Cockpit mark and four packaged-app screenshots. It opens from disk
or any static host. The Mac download currently points to the published v0.1.6 prerelease.

## The interactive demo

The demo bundles **the actual React App, components and CSS from `web/src`**. It uses the
real conversation list, transcript, approval card, composer, agent picker, Files,
Workflows, Memory, recovery screen and preview chrome. The Garden Notes app in Preview is
a browser-only sample built for this tour. The installed app's first-run sample is
separate. The project story, files and replies are synthetic.

`demo/api.ts` replaces the API at build time. `demo/native.ts` replaces the native bridge.
All fixtures and drafts are held in memory; reset or reload discards them. No provider,
process, backend or real file is accessed. The frame CSP blocks network connections.
Unknown operations explain that they need the installed app rather than claiming success.
The outer iframe permits forms so real React Save/Run submit handlers work; CSP blocks
native form navigation. The sandbox is a UI containment aid, not the security boundary:
trusted bundled code, local adapters, escaped text and no connected backend define scope.

The visitor can approve or deny startup, mark a plant watered and filter the care list,
send sample messages,
switch agents, edit/save notes, run a workflow against the saved version, recover a recent
conversation, add/edit memory, filter conversations and reset. Replies and checklist output
are explicitly fixed simulations. Native Mac actions and scheduling require the app.

The landing page uses Cockpit's rounded system typography and light surfaces. Marketing
body copy is 19–21px; main demo conversation text is 17px. `demo/readability.css` records
only demo-specific reading-size and responsive adaptations. At narrow widths Preview
occupies one pane; Close preview returns to the conversation. Expand opens a larger view;
Escape closes it. The agent-team reference informed the guided actions and free exploration.

## Edit and build

- Marketing markup, release copy and screenshot gallery: `index.html`.
- Landing styles: `page.css`.
- Shipped-feature directory: `features.json`, generated into the page by `build-demo.mjs`.
- Guided walkthrough: `demo-tour.js`.
- Browser-only Garden Notes app shown inside Preview: `demo/sample-app.html`.
- Sample backend, native bridge and ephemeral storage: `demo/`.

After editing source, regenerate the embedded UI/CSS/walkthrough:

```sh
node landing/build-demo.mjs
```

The build preserves release copy and screenshot data in `index.html`. Commit the generated
HTML with its source. No build command is needed at the static host. Rebuild intentionally
when production components change, then verify the resulting demo again.
The feature directory describes the v0.1.5 build; v0.1.6 additions are in its release notes until the directory is updated. Check additions against
the tagged user guide and release notes before changing it; features only on development
branches belong in a later release's directory.

## Preview and verify

```sh
python3 -m http.server 4388 --bind 127.0.0.1 --directory landing
node node_modules/typescript/bin/tsc --project landing/tsconfig.demo.json
node landing/check-render.mjs landing/index.html --width 390,768,1280
LANDING_URL=http://127.0.0.1:4388/ node landing/verify.mjs /absolute/evidence/directory
```

The interaction suite exercises the same full journey offline and at LANDING_URL, at
360, 390, 768, 1280 and 1440px, plus a JavaScript-disabled fallback. It verifies visible
results, saved versus unsaved notes, literal rendering of user text, agent handoff,
approval denial/retry, recovery, reset, expanded-view Escape, screenshots/FAQ, readable
font sizes, overflow, exceptions and absence of API calls. Production verification still
requires running the suite against the published URL; local checks and a push are not a
deployment. Screenshot comparisons remain necessary even when browser tests pass.

The hosted page retains Vercel Web Analytics. It is omitted on localhost and from disk.
Outbound repository, release, DMG and feedback links require a network.

## Hosting

Existing Vercel project: `agent-cockpit`; URL: https://agent-cockpit-theta.vercel.app.
The project uses CLI deployment, not Git integration. The static publish root is `landing/`
and its entry is `index.html`. Pushing the redesign branch does not update the live site.
Use the established project/scope when publishing is authorized, then verify the public URL.
