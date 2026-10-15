# Showcase recordings

The three workflow showcases on the landing page each hold a `<video autoplay loop muted
playsinline>` whose `poster` is a real capture from the packaged app. Until a recording
exists the poster is what visitors see, so the page is complete without these files.

Drop a clip in with the exact filename and it starts looping. No markup change:

| File | Showcase | Poster already in place |
|---|---|---|
| `resume-the-thread.mp4` | Resume the thread, not the search. | Recent-work recovery card: task, agent, branch, changed files |
| `the-whole-project.mp4` | The whole project, within reach. | Files panel, Markdown document view |
| `repeat-work-repeatable.mp4` | Make the repeat work repeatable. | Workflow editor with a repeating schedule |

## Recording them

- Capture the packaged app, not the browser demo, at the poster's 2720×1720 aspect ratio
  (all three posters share it). A different ratio letterboxes inside the frame.
- Keep each loop short — 6–12 seconds, one action, no cursor hunting. They autoplay muted,
  so nothing may depend on audio.
- H.264 MP4, `-movflags +faststart`, no audio track. Aim under 3 MB each; these load on
  every visit.

```sh
ffmpeg -i capture.mov -an -vcodec libx264 -crf 26 -pix_fmt yuv420p \
  -movflags +faststart media/resume-the-thread.mp4
```

Until a file lands, the hosted page requests it once per visit and gets a 404. That is
invisible to visitors. To silence one, delete that showcase's `<source>` line in
`index.html` and the poster carries the slot on its own.

`.vercelignore` publishes `index.html` and this directory; nothing else in `landing/`
reaches the host.
