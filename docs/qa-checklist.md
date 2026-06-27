# Focus Lock QA checklist

## Manual unlock and wider popup: 2026-09-09

Verification used isolated Chromium profiles and demonstration tabs.

- [x] The popup is 480 px wide and fits 375 px viewports. The infinity preset starts a session without an end time or automatic breaks. Its confirmation detail reflects the configured delay and optional phrase.
- [x] Unit tests cover indefinite focus accounting, finite paid access, explicit unlock, validation, storage restoration and a hard schedule starting during a manual lock. Timed session behaviour remains covered.
- [x] Independent spec and code review approved the core, background and UI changes. The review found and fixed a hard-schedule upgrade that would have removed the manual exit.
- [x] `npm run check`: Biome, TypeScript, 67 test files, 1,381 passing tests, 2 skipped tests and production build passed.
- [x] All 46 Playwright scenarios passed, including manual lock across browser restart and delayed explicit unlock. A pre-existing coordinate race in the return-to-work test now waits for the stopped-page notice and resolved destination before clicking. The focused test passed ten consecutive runs after the change.
- [x] A dedicated Vite server was started and visited through dev-browser. Production screenshots cover timed and indefinite setup, session options, active popup and overlay, unlock gates and stats in both themes at 1280, 768 and 375 px. Component captures include hover, keyboard focus and disabled controls. The 375 by 500 px overlay scrolls to the confirmation field and Unlock button.
- [x] Independent visual review approved 43 inspected captures, including the infinity preset focus outline and the short overlay's scrolled confirmation controls.
- [x] Browser logs contain no console errors or page exceptions. Chromium emitted module-preload warnings on extension pages.

Evidence is retained in `.playwright-mcp/manual-unlock-qa/`.

## Work-tab scale and destination labels: 2026-09-08

Verification used isolated Chromium 151 profiles and demonstration tabs. The scale measurement supplied 10,000 synthetic metadata records and empty icon responses to the production chooser. Real cached icons and recent-tab ordering were checked separately.

- [x] `npm run check`: Biome, TypeScript, 66 test files, 1,324 passing tests, 2 skipped tests and production build passed.
- [x] All 45 Playwright browser scenarios passed, including search, offscreen keyboard navigation, cached favicons, recent ordering and destination labels in the popup, gate and lockscreen.
- [x] At 1280 by 1000 pixels, 10,000 records produced at most 13 rendered rows. Opening took 209 ms. Four searches took 178 to 212 ms. End reached record 10,000 in 6 ms. The browser recorded no tasks longer than 50 ms during this sample. Timings include automation overhead and describe this machine and synthetic dataset.
- [x] Icon work is limited to four active requests, a bounded worker queue and bounded caches. Tests cover stale responses, metadata refresh, missing icons, oversized data and revoked session, source, policy or privacy context.
- [x] A real discarded tab remained listed and discarded after its cached favicon was read. The local fixture received no extra requests. Raw CDP attached only to the owned extension worker and popup for this check. Discarding a Playwright-attached page triggered a Chromium SIGSEGV, so the raw CDP probe avoids that test-runtime failure.
- [x] Independent spec and quality review approved the implementation after fixes for stale same-domain favicons on refresh and unbounded destination titles.
- [x] Independent visual review approved 44 inspected captures from the 178-image verification matrix. Browser logs contain no console errors or page exceptions. Chromium emitted module-preload warnings on extension pages.
- [x] A dedicated Vite server was started and visited through dev-browser. Production extension screenshots cover full pages, changed components, hover and keyboard focus in light and dark at 1280, 768 and 375 px, plus short windows. Captures verify the actual browser viewport after switching between pages.

Evidence is retained in `.playwright-mcp/tab-picker-scale-qa/`. The README chooser image uses demonstration tabs and locally served test favicons.

## Larger searchable work-tab picker: 2026-09-08

These checks cover source and browser regression commit `194cff3`. Browser screenshots use a disposable Chromium profile with twelve demonstration tabs.

- [x] The chooser expands its panel to 760px while open and fits narrower viewports. A taller scrolling result area reserves its height so the search field stays in place when matches change.
- [x] Search filters locally by title and hostname, ignoring case and surrounding whitespace. Multiple words must all match. Titles, domains and result counts distinguish candidates, and clearing restores the list.
- [x] Search receives focus on open. Arrow Down enters the results, row navigation and Escape work, and pending saves prevent search or refresh from creating selectable rows.
- [x] Refresh and failed-request retry preserve the query. Hostname metadata remains optional for older replies, and new worker replies contain no URL path or query. Existing sender, session and candidate checks remain enforced.
- [x] A delayed initial navigation check no longer detaches an already interactive overlay. The regression covers the actual content entry point and verifies retained search focus, text, selection and a continuously connected host while blocked page content is removed.
- [x] Biome, TypeScript and all 63 unit-test files pass: 1,284 tests passed and 2 skipped. The production build passes.
- [x] The browser search scenario passes five consecutive runs, including actual title/domain filtering, no matches, clearing, stable picker height and keyboard selection of the saved tab.
- [x] All 43 browser scenarios pass. The normal checkout passes `npm run check`, and its 28 rebuilt extension files match the tested bundle byte for byte.
- [x] A dedicated Vite server ran during dev-browser verification. One hundred captures cover full, filtered and empty results in both themes at 1280, 768 and 375px, including component, hover and keyboard-focus detail. Short-viewport captures verify scrolling to the final row at 375x600.
- [x] Independent spec, code and visual reviews passed. Final browser logs contain no console errors or page exceptions. Chromium emitted ten module-preload warnings on extension pages.

Evidence is retained in `.playwright-mcp/searchable-picker-qa/`. The README includes the new chooser screenshot and search controls. Reload the unpacked extension and affected page to load the changes.

## Uninterrupted deep work and work-tab retry: 2026-09-08

The final source is `1c91ebe`. Browser checks used disposable Chromium profiles and demonstration tabs. The retry scenario deliberately injected a failed target lookup. The cause of the user's original lookup failure was not verified in their live browser.

- [x] Reproduced the old 50-minute preset starting with a 25-minute focus phase. Selecting deep work now disables cycles for that draft. Explicitly enabling cycles afterwards remains possible, and the timing preview describes the resulting plan.
- [x] The browser shows `50:00` at session start. The focus phase and session share the same end timestamp, 50 minutes after the start. Existing sessions and saved cycle defaults remain unchanged.
- [x] A failed work-target lookup leaves an enabled retry action. Retrying opens the inline chooser after obtaining a valid worker session ID. Trusted sender validation and attempt accounting remain unchanged.
- [x] Failed, malformed and missing-session refreshes retain visible keyboard focus. Pending background retries preserve deliberate focus changes and gate input.
- [x] The normal checkout passes `npm run check`: Biome, TypeScript, 61 test files, 1,267 passing tests, 2 skipped tests and production build.
- [x] All 42 browser scenarios passed before the final focus handoff adjustment. The 12 session-length and work-target browser scenarios passed again on the final normal-checkout build.
- [x] A dedicated Vite server ran during dev-browser verification. The final build has 108 captures across light and dark themes at 1280, 768 and 375 px. All five states have full-page and component captures. Changed preset and retry controls also have hover and keyboard-focus captures.
- [x] Independent visual review approved the timing preview, countdown, retry guidance and recovered picker. Final browser logs contain no console errors or page exceptions. Chromium emitted module-preload warnings on extension pages.

Evidence is retained in `.playwright-mcp/countdown-qa/`. Reload the unpacked extension and affected pages to load the new code. An already-started session keeps its original cycle configuration.

## Work tab picker verification: 2026-09-08

The picker screenshots cover source commit `2176e9fb4f93367e209eeb938ef4523aac9ef5d0`. Final automated checks also include list ordering fix `7502644`. Browser checks used isolated Chromium profiles with demonstration tabs.

- [x] `npm run check`: Biome, TypeScript, 61 test files, 1,253 passing tests, 2 skipped tests and production build passed.
- [x] `npm run e2e`: all 40 browser scenarios passed on the final source.
- [x] Delayed hashing preserves the arrival order of local and synced list updates. Held-hash regressions cover both sources.
- [x] The normal checkout passes `npm run check`. Generated design mockups are excluded from source lint. Its rebuilt `dist` matches all 28 tested build files byte for byte.
- [x] The popup chooses the actual current allowed tab and retains another-tab selection. A delayed lookup cannot overwrite a newer manual choice.
- [x] The inline picker filters allowed tabs, saves the selected target and returns without losing page input. Empty, closed and stale targets have recovery paths.
- [x] Retry, pending save cancellation, unavailable triggers and failed returns retain keyboard focus within the lockscreen. Gate abandonment remains available without a work target.
- [x] A dedicated Vite server ran during dev-browser checks of the production extension. Full-page, component, hover and keyboard-focus captures cover both themes at 1280, 768 and 375 px.
- [x] Independent visual review approved popup start and active states plus missing, open, ready, long-title, unavailable, empty and gate-without-target overlay states.
- [x] Browser logs contain no console errors or page exceptions. Chromium emitted 25 module-preload warnings on extension pages.

Evidence is retained in `.playwright-mcp/work-tab-picker-qa/`. The guide includes the inline chooser and refreshed popup, overlay and gate screenshots.

## Return-to-work verification: 2026-09-07

The checks below cover source commit `9cf571ce51a1895ab14e55ae8c58beb0f504a0a3`. All browser runs used isolated Chromium profiles. The screenshots use demonstration tasks and seeded aggregate statistics.

- [x] `npm run check`: Biome, TypeScript, 61 test files, 1,231 passing tests, 2 skipped tests, icon generation and production build passed.
- [x] `npm run e2e`: all 37 browser scenarios passed.
- [x] Returning activates the selected tab and its window while preserving both pages, including draft text, scroll position and JavaScript state.
- [x] The popup suggests the current suitable work tab, saves the selected next step, and replaces a closed target. Stale sessions and newly blocked targets are rejected. Browser restart preserves the focus session while clearing the work-tab reference.
- [x] Returning abandons the gate without spending credit and clears its visible controls. Delayed responses cannot replace feedback from a newer action or session. Failed activation also reconciles the gate while retaining the error.
- [x] Work-target reads do not commit session state or trigger notification loops. Unrelated tab events do not fan out content messages. Existing attempt accounting tests pass.
- [x] Typed gate text, selection, keyboard focus, expanded details and overlay scroll survive updates. Real wheel and touch gestures scroll long content while the blocked document stays still.
- [x] Access actions show their own duration, cost and readiness. Credit limits, disabled earning, insufficient remaining focus and exact phase boundaries have regression coverage. Final breaks that leave no further focus time display session completion.
- [x] Vite ran on a dedicated development port. Dev-browser inspected the production extension with full-page and component captures in light and dark at 1280, 768 and 375 px.
- [x] Visual coverage includes popup start, active and gate states, existing and stopped documents, expanded access controls, missing targets, typed and untyped gates, force-end controls, long next steps, Options and Stats. Hover and keyboard-focus captures cover primary actions, selectors and gate controls.
- [x] No browser console errors or page exceptions were recorded. Chromium emitted module-preload warnings on extension documents. These warnings did not prevent modules or controls from working.

Evidence is retained in `.playwright-mcp/return-to-work-qa/`, including screenshots, capture scripts and test logs. The five screenshots in `docs/images/focus-lock/` were refreshed from this run.

## Archived verification: 2026-08-30

Last updated: 2026-08-30. Automated browser evidence targets exact source commit `c87383f1cd441a9ecc2d175daa3df9e4b8825b3d`. The run started from a clean worktree at the same commit as `master` and ended on that commit. It used isolated headless Chrome-for-Testing 151.0.7922.34 profiles and did not touch the user's Chrome.

## Exact automated gates

- [x] `NO_COLOR=1 npm run check` passed with 56 test files, 1,139 tests passed, and 2 skipped. Biome, TypeScript, deterministic icon generation, and the production build passed.
- [x] `NO_COLOR=1 npm run e2e` rebuilt the extension and passed all 30 Playwright scenarios in isolated Chrome-for-Testing profiles.
- [x] The exact visual and behavior run recorded 568 artifacts, including 207 surface captures and 78 hover or focus interactions. The generated review set contains 42 contact sheets.
- [x] The report records `sameHead: true`, all three clean exact-source checks as true, and a fresh-build distribution hash match.

## Automated browser behavior

- [x] The Manifest V3 worker loaded and answered extension-page requests. Popup, Options, Stats, content overlay, stopped-document overlay, and gate surfaces rendered.
- [x] Fresh blocked navigation stopped before page content rendered. Existing pages were overlaid and muted without reload. Session completion restored page state and cleared browser effects.
- [x] Pause, unlock, abandon, and cancellation gates used the configured delay and optional typing requirement. Gate choices include 0, 10, 30, and custom whole seconds. A 0-second delay still required the configured typed phrase. Typing-off cancellation accepted no phrase after the configured delay. Typing-on cancellation rejected missing and inexact phrases. A single-site unlock left another site blocked and reblocked after expiry.
- [x] The optional `Ignore timeout and end anyway` action appeared only for eligible friction cancellation gates. It ended the session before the 30-second delay and typed phrase were satisfied. Hard sessions remained non-cancellable.
- [x] Popup and overlay pause gates used `Take the pause`. The popup gate started disabled and exposed visible hover and keyboard-focus states after its delay.
- [x] Hard sessions displayed the Options lock banner, rejected weakening changes with readable text, and accepted stronger rules.
- [x] A stale popup category edit was rejected by the real worker. The popup restored the authoritative category value.
- [x] Saved schedule rows rendered their selected day pills. An active schedule window started a scheduled focus session.
- [x] The persistent-profile restart scenario restored the active focus phase, timer, stopped document, overlay, and extension-owned mute state.
- [x] The theme control cycled Auto, Light, Dark, and back to Auto from Popup, Options, and Stats. Each change persisted through reload. Explicit Light stayed light under dark operating-system media, explicit Dark stayed dark under light media, and Auto followed both media modes.
- [x] Existing-page and stopped-page overlays changed theme while already mounted. Their active and stopped presentations remained distinct.
- [x] Stats displayed the complete settings menu. Every Options destination used the correct section hash, the active destination used `aria-current`, and a Stats to Options to Stats round trip preserved navigation parity.
- [x] Lists and categories share one settings view and one save action. Global category actions selected and deselected all known category switches without changing site exclusions. Per-category actions selected and deselected bundled sites without changing the parent category or deleting stale exclusions.
- [x] Green Selected and red Deselected counts matched category and bundled-site state. A persisted partial Social media selection reloaded expanded with `Selected 11`, `Deselected 1`, and its collapse action disabled.
- [x] Sync data and local runtime data kept their documented storage split. Per-item and projected total Chrome Sync quota checks passed.
- [x] Short, default, and deep presets saved through `Save strictness and gate` as `7.5`, `27`, and `62`. Reloaded DOM values and worker settings matched. Values `0` and `72000000001` produced field-specific errors and did not replace the saved values.
- [x] The freeze-token interval saved through `Save pause economy` as `5`. Reloaded DOM and worker settings matched. Values `0`, `1.5`, and `100000001` produced field-specific errors without replacing the saved value.
- [x] With `Show a system notification when a session completes` disabled, a completed short session created no notification. Enabling and saving the setting made the next completed short session create a notification.
- [x] The schedule-start notification remained independent. It created a notification while the session-completion notification setting was disabled.
- [x] The action badge showed the focus countdown and cleared on completion. The isolated pinned-toolbar capture from commit `0ed0c27` shows the break-state teal closed lock, progress-ring outline, and cup mark. Changes through exact source commit `9f453d6` did not alter the drawing or generated pixels. A fresh capture attempt prepared the break state in Chrome-for-Testing 151.0.7922.34, but Computer Use could not target the window because two installed Chrome-for-Testing versions expose the same bundle identifier.

## Visual inspection

- [x] Popup idle, active, gate, pending-category, and category-rejection states were inspected in Auto with light media, Auto with dark media, explicit Light with dark media, and explicit Dark with light media at 1280 px, 768 px, 375 px, and native 340 px popup width where applicable.
- [x] Existing-page overlay, stopped-document overlay, typed, untyped, and force-end gate, Options, and Stats surfaces were inspected in all four theme and media cases at 1280 px, 768 px, and 375 px.
- [x] Options preset, gate controls, merged lists and categories, partial category, freeze interval, notification, and saved-schedule groups have full-page and focused component captures at all three widths in both themes.
- [x] Options rejection has full-page and focused alert captures at 375 px in both themes.
- [x] Component captures cover rings, budget meters, actions, schedule day pills, hard-session rejection, Options controls, Stats pause and unlock columns, and chart focus states.
- [x] Hover and keyboard focus artifacts cover the popup cog and theme control, both settings menus, all four category bulk actions, typed and untyped gate confirmation, overlay actions, and Stats chart controls in all four theme and media cases.
- [x] Text rendering, spacing, responsive layout, full-page captures, component captures, and all 42 contact sheets were inspected. No Critical or Important visual defect remained.
- [x] Stats chart labels remain at least 9 rendered px across 375 through 1280 px. Boundary tests cover all container-query transitions. SVG labels remain inside their view boxes without date, tick, bar, domain, or value collisions, including first-bin maxima, long domains, and seven-digit values.
- [x] The report records zero viewport overflow or unrelated horizontal scrollers. The wide Recent sessions table remains contained in its intentional in-viewport `.table-scroll` region at 375 px and 768 px.

## Diagnostics

- [x] Console errors: 0.
- [x] Page errors: 0.
- [x] Worker errors: 0.
- [x] Request failures: 0.
- [x] Blocked requests: 0.
- [x] Four shutdown-only worker messages were excluded from worker errors and classified as `intentional-browser-shutdown`. Every message had the exact text `focus-lock background error Error: The browser is shutting down.`

## Manual-only checks

- [ ] Confirm Chrome Sync across two signed-in profiles.
- [ ] Hear session-complete, break-start, break-end, and schedule-start sounds through real speakers.
- [ ] Confirm operating-system-visible notifications outside the isolated browser environment.
- [ ] Confirm blocking in an incognito tab after enabling the per-extension permission in a safe isolated profile.
- [ ] Confirm the untracked `key.pem` has an external backup.

## QA artifacts

The exact evidence directory is `.playwright-mcp/qa-final/master-c87383f1-exact-1788116604430/`.

- Report: `.playwright-mcp/qa-final/master-c87383f1-exact-1788116604430/qa-report.json`
- Shutdown messages: `.playwright-mcp/qa-final/master-c87383f1-exact-1788116604430/shutdown-worker-messages.json`
- Contact sheets: `.playwright-mcp/qa-final/master-c87383f1-exact-1788116604430/contact-*.png`
- Pinned-toolbar capture: `.playwright-mcp/qa-final/toolbar-break-0ed0c275-1788052452918/toolbar-pinned-break-crop.png`
- Fresh-toolbar prepared profile: `.playwright-mcp/qa-final/toolbar-break-9f453d64-1788070444526/`

Curated repository screenshots use exact-run sources:

- `docs/images/focus-lock/popup-active.png` from `popup-active-light-dark-media-375-full.png`
- `docs/images/focus-lock/overlay.png` from `overlay-existing-light-dark-media-375-full.png`
- `docs/images/focus-lock/gate.png` from `stop-session-gate-light-dark-media-1280-full.png`
- `docs/images/focus-lock/options.png` from `options-light-dark-media-1280-full.png`
- `docs/images/focus-lock/stats.png` from `stats-dark-light-media-1280-curated.png`
