# README product tour media

The README uses fresh captures of the extension in an isolated Playwright Chromium profile. The example task is "Finish the proposal". The work document and recorded history are demonstration data. The extension renders its own interface and handles the session and Back to work actions.

| File | Capture |
| --- | --- |
| `focus-session.png` | The complete 480 by 600 popup, ready to start a 25-minute session with the work tab selected. |
| `blocked-page.png` | The real blocking overlay on a locally served distracting page. |
| `progress.png` | The Stats overview with one completed hour yesterday and the live demonstration session. |
| `demo-poster.png` | A readable still of the blocking overlay. |
| `demo.gif` | A 10-second loop. The work document, the blocked tab and Back to work returning to the original work tab. |

The blocked-page and animation frames are 960 by 640 pixels. Stats is 1280 pixels wide and ends after the first complete focus chart. Browser chrome is outside each capture. Further Stats detail is below the captured viewport. Light theme is selected through the extension's settings.

## Capture

Install the repository's locked dependencies and Playwright Chromium, with `ffmpeg` on `PATH`. Run from the repository root. A clean subprocess environment keeps unrelated account settings and credentials out of browser launch diagnostics:

```sh
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node scripts/gen-icons.mjs
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node node_modules/vite/bin/vite.js build
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" TZ=Europe/Amsterdam UPDATE_README_MEDIA=1 \
  node node_modules/@playwright/test/cli.js test tests/e2e/readme-media.spec.ts \
  -g 'captures the README product tour'
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  node node_modules/@playwright/test/cli.js test tests/e2e/readme-media.spec.ts \
  -g 'validates the README media inventory'
```

The capture test requires `UPDATE_README_MEDIA=1` before replacing tracked media. Without that flag it skips before creating a browser profile, and the inventory check still runs. It rejects `FOCUS_LOCK_E2E_DIST` overrides before launching a browser, so the recorded build is always the repository's `dist/`. Its fixture creates and closes its own extension profile. The store screenshot inventory is separate and unchanged.

The animation samples real pages eight times per second. At two seconds it activates the blocked tab. At six seconds it clicks the actual Back to work control and verifies that Chrome activates the original work tab. `ffmpeg` encodes those frames with a 128-colour palette. Every output must stay below 5 MB.

`provenance.json` records the actual capture timestamp, source commit, extension version, tool versions, production build digest, package lock and capture script hashes, and each media file's byte count and SHA-256 hash. Its `reproductionInstructions` repeat the commands above as a recipe for a fresh run. Paths are repository-relative. The recorded history is one seeded completed hour and one blocked attempt yesterday. Session start, current blocking and return to the selected work tab use the running extension.

After capture, inspect each PNG at full size and inspect animation frames before and after the tab changes. Check text, clipping, spacing and the return destination. The fixture checks browser diagnostics. The inventory check validates file hashes and size limits, but visual inspection remains a separate step.
