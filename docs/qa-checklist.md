# Focus Lock QA checklist

Last updated: 2026-08-30. Automated browser evidence targets exact source commit `8fd376190e058352b73106e9160b178ac6a8912a`. The run started from a clean detached worktree and ended at the same commit. It used isolated headless Chrome-for-Testing 151.0.7922.34 profiles and did not touch the user's Chrome.

## Exact automated gates

- [x] `NO_COLOR=1 npm run check` passed 39 test files with 848 tests passed and 2 skipped. Biome, TypeScript, deterministic icon generation, and the production build passed.
- [x] A separate `npm run build` completed successfully from the exact source commit.
- [x] `NO_COLOR=1 npm run e2e` rebuilt the extension and passed all 23 Playwright scenarios in isolated Chrome-for-Testing profiles.
- [x] The exact visual and behavior run recorded 190 artifacts. The generated review set contains 26 contact sheets.
- [x] The report records `sameHead: true` and `cleanTrackedSourceAtStart: true`.

## Automated browser behavior

- [x] The Manifest V3 worker loaded and answered extension-page requests. Popup, Options, Stats, content overlay, stopped-document overlay, and gate surfaces rendered.
- [x] Fresh blocked navigation stopped before page content rendered. Existing pages were overlaid and muted without reload. Session completion restored page state and cleared browser effects.
- [x] Pause, unlock, abandon, and cancellation gates enforced their delays and phrases. A single-site unlock left another site blocked and reblocked after expiry.
- [x] Hard sessions displayed the Options lock banner, rejected weakening changes with readable text, and accepted stronger rules.
- [x] A stale popup category edit was rejected by the real worker. The popup restored the authoritative category value.
- [x] Saved schedule rows rendered their selected day pills. An active schedule window started a scheduled focus session.
- [x] The persistent-profile restart scenario restored the active focus phase, timer, stopped document, overlay, and extension-owned mute state.
- [x] Sync data and local runtime data kept their documented storage split. Per-item and projected total Chrome Sync quota checks passed.
- [x] Short, default, and deep presets saved through `Save strictness and gate` as `7.5`, `27`, and `62`. Reloaded DOM values and worker settings matched. Values `0` and `72000000001` produced field-specific errors and did not replace the saved values.
- [x] Freeze token interval saved through `Save pause economy` as `5`. Reloaded DOM and worker settings matched. Values `0`, `1.5`, and `100000001` produced field-specific errors and did not replace the saved value.
- [x] With `Show a system notification when a session completes` disabled, a completed short session created no notification. Enabling and saving the setting made the next completed short session create a notification.
- [x] Schedule-start notification remained independent. It created a notification while the session-completion notification setting was disabled.
- [x] The action badge showed a focus countdown and cleared on completion. The earlier isolated pinned-toolbar capture shows the break-state teal closed lock, progress-ring outline, and cup mark. `src/background/icon.ts`, `scripts/gen-icons.mjs`, and the icon assets did not change between capture commit `0ed0c27` and exact source commit `8fd3761`.

## Visual inspection

- [x] Popup idle and active states were inspected in light and dark themes at 1280 px, 768 px, 375 px, and native 340 px popup width where applicable.
- [x] Existing-page overlay, stopped-document overlay, gate, Options, and Stats surfaces were inspected in light and dark themes at 1280 px, 768 px, and 375 px.
- [x] Options preset, freeze interval, and notification groups each have full-page and focused component captures at all three widths in both themes.
- [x] Component captures cover rings, budget meters, actions, schedule day pills, hard-session rejection, Options controls, and the Stats Pause and Unlock columns.
- [x] Hover, keyboard focus, text rendering, spacing, and responsive layout were inspected. The report records zero horizontal overflow.
- [x] The 26 contact sheets and the new 375 px component captures were inspected. No Critical or Important visual defect remained.

## Diagnostics

- [x] Console errors: 0.
- [x] Page errors: 0.
- [x] Worker errors: 0.
- [x] Request failures: 0.
- [x] Blocked requests: 0.
- [x] Four shutdown-only worker messages were excluded from worker errors and classified as `intentional-browser-shutdown`. Two came from the Options profile and two came from the popup-rejection profile. Every message has the exact text `focus-lock background error Error: The browser is shutting down.`

## Manual-only checks

- [ ] Confirm Chrome Sync across two signed-in profiles.
- [ ] Hear session-complete, break-start, break-end, and schedule-start sounds through real speakers.
- [ ] Confirm operating-system-visible notifications outside the isolated browser environment.
- [ ] Confirm blocking in an incognito tab after enabling the per-extension permission in a safe isolated profile.
- [ ] Confirm the untracked `key.pem` has an external backup.

## QA artifacts

The exact evidence directory is `.playwright-mcp/qa-final/master-8fd37619-exact-1788056655784/`.

- Report: `.playwright-mcp/qa-final/master-8fd37619-exact-1788056655784/qa-report.json`
- Shutdown messages: `.playwright-mcp/qa-final/master-8fd37619-exact-1788056655784/shutdown-worker-messages.json`
- Contact sheets: `.playwright-mcp/qa-final/master-8fd37619-exact-1788056655784/contact-*.png`
- Pinned-toolbar capture: `.playwright-mcp/qa-final/toolbar-break-0ed0c275-1788052452918/toolbar-pinned-break-crop.png`

Curated repository screenshots use these exact-run sources:

- `docs/images/focus-lock/popup-active.png` from `popup-active-light-375-full.png`
- `docs/images/focus-lock/overlay.png` from `overlay-existing-light-375-full.png`
- `docs/images/focus-lock/gate.png` from `gate-light-1280-full.png`
- `docs/images/focus-lock/options.png` from `options-light-1280-full.png`
- `docs/images/focus-lock/stats.png` from `stats-dark-1280-curated.png`
