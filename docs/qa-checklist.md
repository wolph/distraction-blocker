# Focus Lock QA checklist

Last updated: 2026-08-30. Automated browser evidence targets exact source commit `8de7043e7f2ad6bea5bc6b2cdd0f1fd9a86a8cc6`. The run started from a clean `master` worktree and ended on the same commit. It used isolated headless Chrome-for-Testing 151.0.7922.34 profiles and did not touch the user's Chrome.

## Exact automated gates

- [x] `NO_COLOR=1 npm run check` passed with 56 test files, 1,122 tests passed, and 2 skipped. Biome, TypeScript, deterministic icon generation, and the production build passed.
- [x] `NO_COLOR=1 npm run e2e` rebuilt the extension and passed all 28 Playwright scenarios in isolated Chrome-for-Testing profiles.
- [x] The exact visual and behavior run recorded 512 artifacts, including 183 surface captures and 74 hover or focus interactions. The generated review set contains 38 contact sheets.
- [x] The report records `sameHead: true`, all three clean exact-source checks as true, and a fresh-build distribution hash match.

## Automated browser behavior

- [x] The Manifest V3 worker loaded and answered extension-page requests. Popup, Options, Stats, content overlay, stopped-document overlay, and gate surfaces rendered.
- [x] Fresh blocked navigation stopped before page content rendered. Existing pages were overlaid and muted without reload. Session completion restored page state and cleared browser effects.
- [x] Pause, unlock, abandon, and cancellation gates used the configured delay and optional typing requirement. Typing-off cancellation accepted no phrase after the configured delay. Typing-on cancellation rejected missing and inexact phrases. A single-site unlock left another site blocked and reblocked after expiry.
- [x] Popup and overlay pause gates used `Take the pause`. The popup gate started disabled and exposed visible hover and keyboard-focus states after its delay.
- [x] Hard sessions displayed the Options lock banner, rejected weakening changes with readable text, and accepted stronger rules.
- [x] A stale popup category edit was rejected by the real worker. The popup restored the authoritative category value.
- [x] Saved schedule rows rendered their selected day pills. An active schedule window started a scheduled focus session.
- [x] The persistent-profile restart scenario restored the active focus phase, timer, stopped document, overlay, and extension-owned mute state.
- [x] The theme control cycled Auto, Light, Dark, and back to Auto from Popup, Options, and Stats. Each change persisted through reload. Explicit Light stayed light under dark operating-system media, explicit Dark stayed dark under light media, and Auto followed both media modes.
- [x] Existing-page and stopped-page overlays changed theme while already mounted. Their active and stopped presentations remained distinct.
- [x] Stats displayed the complete settings menu. Every Options destination used the correct section hash, the active destination used `aria-current`, and a Stats to Options to Stats round trip preserved navigation parity.
- [x] Global category actions selected and deselected all known category switches without changing site exclusions. Per-category actions selected and deselected bundled sites without changing the parent category or deleting stale exclusions.
- [x] Sync data and local runtime data kept their documented storage split. Per-item and projected total Chrome Sync quota checks passed.
- [x] Short, default, and deep presets saved through `Save strictness and gate` as `7.5`, `27`, and `62`. Reloaded DOM values and worker settings matched. Values `0` and `72000000001` produced field-specific errors and did not replace the saved values.
- [x] The freeze-token interval saved through `Save pause economy` as `5`. Reloaded DOM and worker settings matched. Values `0`, `1.5`, and `100000001` produced field-specific errors without replacing the saved value.
- [x] With `Show a system notification when a session completes` disabled, a completed short session created no notification. Enabling and saving the setting made the next completed short session create a notification.
- [x] The schedule-start notification remained independent. It created a notification while the session-completion notification setting was disabled.
- [x] The action badge showed the focus countdown and cleared on completion. The isolated pinned-toolbar capture from commit `0ed0c27` shows the break-state teal closed lock, progress-ring outline, and cup mark. Changes through exact source commit `9f453d6` did not alter the drawing or generated pixels. A fresh capture attempt prepared the break state in Chrome-for-Testing 151.0.7922.34, but Computer Use could not target the window because two installed Chrome-for-Testing versions expose the same bundle identifier.

## Visual inspection

- [x] Popup idle, active, gate, pending-category, and category-rejection states were inspected in Auto with light media, Auto with dark media, explicit Light with dark media, and explicit Dark with light media at 1280 px, 768 px, 375 px, and native 340 px popup width where applicable.
- [x] Existing-page overlay, stopped-document overlay, typed and untyped gate, Options, and Stats surfaces were inspected in all four theme and media cases at 1280 px, 768 px, and 375 px.
- [x] Options preset, freeze interval, notification, and saved-schedule groups have full-page and focused component captures at all three widths in both themes.
- [x] Options rejection has full-page and focused alert captures at 375 px in both themes.
- [x] Component captures cover rings, budget meters, actions, schedule day pills, hard-session rejection, Options controls, Stats pause and unlock columns, and chart focus states.
- [x] Hover and keyboard focus artifacts cover the popup cog and theme control, both settings menus, all four category bulk actions, typed and untyped gate confirmation, overlay actions, and Stats chart controls in all four theme and media cases.
- [x] Text rendering, spacing, responsive layout, full-page captures, component captures, and all 38 contact sheets were inspected. No Critical or Important visual defect remained.
- [x] Stats chart labels remain at least 9 rendered px across 375 through 1280 px. Boundary tests cover all container-query transitions. SVG labels remain inside their view boxes without date, tick, bar, domain, or value collisions, including first-bin maxima, long domains, and seven-digit values.
- [x] The report records zero viewport overflow or unrelated horizontal scrollers. The wide Recent sessions table remains contained in its intentional in-viewport `.table-scroll` region at 375 px and 768 px.

## Diagnostics

- [x] Console errors: 0.
- [x] Page errors: 0.
- [x] Worker errors: 0.
- [x] Request failures: 0.
- [x] Blocked requests: 0.
- [x] Three shutdown-only worker messages were excluded from worker errors and classified as `intentional-browser-shutdown`. Every message had the exact text `focus-lock background error Error: The browser is shutting down.`

## Manual-only checks

- [ ] Confirm Chrome Sync across two signed-in profiles.
- [ ] Hear session-complete, break-start, break-end, and schedule-start sounds through real speakers.
- [ ] Confirm operating-system-visible notifications outside the isolated browser environment.
- [ ] Confirm blocking in an incognito tab after enabling the per-extension permission in a safe isolated profile.
- [ ] Confirm the untracked `key.pem` has an external backup.

## QA artifacts

The exact evidence directory is `.playwright-mcp/qa-final/master-8de7043e-exact/`.

- Report: `.playwright-mcp/qa-final/master-8de7043e-exact/qa-report.json`
- Shutdown messages: `.playwright-mcp/qa-final/master-8de7043e-exact/shutdown-worker-messages.json`
- Contact sheets: `.playwright-mcp/qa-final/master-8de7043e-exact/contact-*.png`
- Pinned-toolbar capture: `.playwright-mcp/qa-final/toolbar-break-0ed0c275-1788052452918/toolbar-pinned-break-crop.png`
- Fresh-toolbar prepared profile: `.playwright-mcp/qa-final/toolbar-break-9f453d64-1788070444526/`

Curated repository screenshots use exact-run sources:

- `docs/images/focus-lock/popup-active.png` from `popup-active-light-dark-media-375-full.png`
- `docs/images/focus-lock/overlay.png` from `overlay-existing-light-dark-media-375-full.png`
- `docs/images/focus-lock/gate.png` from `stop-session-gate-light-dark-media-1280-full.png`
- `docs/images/focus-lock/options.png` from `options-light-dark-media-1280-full.png`
- `docs/images/focus-lock/stats.png` from `stats-dark-light-media-1280-curated.png`
