# Cockpit landing page

Two static pages, each self-contained and openable from disk or any static host:

- **`index.html`** (~1.1 MB) — the marketing page: hero, get-started card, compatibility
  strip, three workflow showcases, Top features, release, FAQ. Four packaged-app captures
  are embedded as data URIs.
- **`demo.html`** (~2.0 MB) — the interactive demo on its own page, carrying the bundled
  Cockpit UI payload. The landing page links to it and ships none of it.

The Mac download points to the v0.1.8 prerelease.

## Page order

`index.html`: hero (two-tone headline, download + browser-demo buttons, flat-panel product
visual, then the get-started card) → compatibility strip → three showcases → try-the-demo
banner → Top features with the full directory behind a disclosure → release and setup →
FAQ → feedback and footer.

The visual language is deliberately near-monochrome: charcoal primary buttons, hairline
secondary buttons, flat `--panel` grey behind product media, and two-tone headings where
the first line is grey and the second is ink. No section carries an eyebrow mini-title —
`verify-demo.mjs` asserts `main .eyebrow` is empty.

Greys are split by WCAG threshold: `--soft` (#70726a) clears 4.5:1 for small text,
`--soft-lg` (#85877e) is for headings only, which need 3:1. Swapping one for the other
fails `check-render.mjs`. Marketing reading copy stays at the 19px floor.

The get-started card is the only place to start: Apple-silicon download with the Apple
mark, a coming-soon note for other platforms, the Terminal install command in a light pill
with a copy button, and the docs link. There is no second install block further down.

Each showcase holds a `<video autoplay loop muted playsinline>` over a real packaged-app
capture as its `poster`, so the section is complete before any recording exists. Drop a
clip into `media/` with the filename that showcase already points at and it starts looping;
see [media/README.md](media/README.md). `.vercelignore` publishes `index.html`, `demo.html`
and `media/`, nothing else. Under `prefers-reduced-motion` the clips hold on the poster and
only gain controls once real media loads.

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
only demo-specific reading-size and responsive adaptations. At narrow widths Workspace and Preview
tabs switch between the conversation and sample app; Close preview returns to the conversation. Expand opens a larger view;
Escape closes it. The agent-team reference informed the guided actions and free exploration.

## Edit and build

- Marketing markup, release copy, hero visual and showcase posters: `index.html`.
- Demo page shell and the embedded demo payload: `demo.html`.
- Landing styles: `page.css`.
- Curated Top features: hand-written in `index.html`. The six cards are an editorial
  choice, not a generated slice of `features.json`; change them there.
- Shipped-feature directory behind `Browse all features →`: `features.json`, generated
  into the page by `build-demo.mjs`.
- Showcase recordings: `media/` (see its README). Posters live in `index.html`.
- Guided walkthrough: `demo-tour.js`.
- Browser-only Garden Notes app shown inside Preview: `demo/sample-app.html`.
- Sample backend, native bridge and ephemeral storage: `demo/`.

After editing source, regenerate the embedded UI/CSS/walkthrough:

```sh
node landing/build-demo.mjs
```

The build rewrites the demo payload and walkthrough in `demo.html` and the feature
directory in `index.html`, and refreshes the shared stylesheet in both. It preserves
release copy and screenshot data. Commit the generated
HTML with its source. No build command is needed at the static host. Rebuild intentionally
when production components change, then verify the resulting demo again.
The feature directory covers the published v0.1.8 scope, including v0.1.6 worktrees/accounts/phone preview, v0.1.7 interaction fixes and v0.1.8 approval, account and network-trust changes. `release.json` records the download version independently of `package.json`: source/local builds can be newer than the published download. Check additions against the tagged guide and release notes; unpublished repairs belong in the source docs, not in the shipped-feature list. The demo is rebuilt from current main and labelled accordingly, so visitors know the public download can differ.

## Preview and verify

```sh
python3 -m http.server 4388 --bind 127.0.0.1 --directory landing
node node_modules/typescript/bin/tsc --project landing/tsconfig.demo.json
node landing/check-render.mjs landing/index.html landing/demo.html --width 390,768,1280
LANDING_URL=http://127.0.0.1:4388/ node landing/verify.mjs /absolute/evidence/directory
```

The interaction suite exercises the same full journey offline and at LANDING_URL, at
360, 390, 768, 1280 and 1440px across both pages, plus a JavaScript-disabled fallback. It verifies visible
results, saved versus unsaved notes, literal rendering of user text, agent handoff,
approval denial/retry, recovery, reset, expanded-view Escape, the get-started card
(Apple mark, platform note, install command, Copy, docs link), the absence of section
eyebrows, three looping-but-still showcase clips over real posters, six Top features with
the directory closed on load, every download link, that the demo payload stays off the
landing page, the hand-off to `demo.html`, the FAQ, readable
font sizes, overflow, exceptions and absence of API calls. Production verification still
requires running the suite against the published URL; local checks and a push are not a
deployment. Screenshot comparisons remain necessary even when browser tests pass.

The hosted page retains Vercel Web Analytics. It is omitted on localhost and from disk.
Outbound repository, release, DMG and feedback links require a network.

## Hosting

Existing Vercel project: `agent-cockpit`; URL: https://agent-cockpit-theta.vercel.app.
The project uses CLI deployment, not Git integration. The static publish root is `landing/`
and its entries are `index.html` and `demo.html`. Pushing the redesign branch does not update the live site.
Use the established project/scope when publishing is authorized, then verify the public URL.
