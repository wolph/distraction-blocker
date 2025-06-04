# Focus Lock QA checklist

Last updated: 2026-09-01. The full visual browser evidence below targets exact source commit `c87383f1cd441a9ecc2d175daa3df9e4b8825b3d`. That run started from a clean worktree at the same commit as `master` and ended on that commit. It used isolated headless Chrome-for-Testing 151.0.7922.34 profiles and did not touch the user's Chrome.

## Exact automated gates

- [x] `NO_COLOR=1 npm run check` passed with 56 test files, 1,139 tests passed, and 2 skipped. Biome, TypeScript, deterministic icon generation, and the production build passed.
- [x] `NO_COLOR=1 npm run e2e` rebuilt the extension and passed all 30 Playwright scenarios in isolated Chrome-for-Testing profiles.
- [x] The exact visual and behavior run recorded 568 artifacts, including 207 surface captures and 78 hover or focus interactions. The generated review set contains 42 contact sheets.
- [x] The report records `sameHead: true`, all three clean exact-source checks as true, and a fresh-build distribution hash match.

## Runtime permission onboarding evidence

Task 5 fixes are recorded in commit `364560292daa58f327802aae40082556aaa6128b` with Google Chrome for Testing 151.0.7922.34. Every browser run used an isolated Playwright profile and did not touch the user's Chrome. The verification ran in the shared integration worktree with this commit checked out plus preserved in-progress Task 2 popup edits. The results validate that integrated state, not a clean exact tree for this commit alone.

- [x] `npm run build && npx playwright test tests/e2e/onboarding.spec.ts tests/e2e/restart.spec.ts` passed all 7 scenarios in 45.9 seconds. It covered a fresh install without host access, the incomplete popup, delayed onboarding loading and step transitions, denial and retry, a granted dynamic registration, local and Sync completion, browser restart, permission revocation, rejected session start after revocation, a real blocked page after grant, and restored blocking after restart.
- [x] The real Chrome Sync quota scenario filled only test-owned keys, preserved unrelated Sync data, forced first publication to fail, and kept setup incomplete with local choices, the pending journal, and the checkpoint intact. The state survived a protocol-level background-worker stop and a browser restart. Removing only the test filler allowed retry. Both recovered local and remote settings and lists matched the captured pre-failure local snapshot.
- [x] Playwright cannot attach listeners before `launchPersistentContext` returns. The fixture attaches page, worker, and context-level request listeners immediately after launch, then forces a monitored worker stop and restart before behavior assertions for every production, temporary permission, and restart launch. The onboarding and restart scenarios recorded zero browser console, page, worker, request, and blocked-request errors through monitored worker boot, initial navigation, permission-bootstrap launches, and restarts.
- [x] Every final browser context closed before fixture diagnostics were asserted. Teardown failures and diagnostics failures are aggregated. Shutdown-only worker messages are retained in a separate bucket and accepted only when they exactly equal `focus-lock background error Error: The browser is shutting down.`
- [x] `NO_COLOR=1 npm run check` passed 68 test files with 1,734 tests passed and 2 skipped. Biome, TypeScript, deterministic icon generation, and the production build passed.
- [x] `NO_COLOR=1 npm run e2e` rebuilt the extension and passed all 37 Playwright scenarios in 3.8 minutes.
- [x] Automated grant setup launched a test-only copy of the same extension ID with required HTTP and HTTPS host permissions, then relaunched the production optional-permission manifest. This exercised Chrome's persisted permission state, dynamic registration, revocation, and enforcement without faking extension APIs.
- [x] Task 6 captured the native Chrome permission warning in a headed, isolated Chrome-for-Testing 151.0.7922.34 profile. The prompt was absent before clicking `Enable website blocking`, appeared only after that click, disappeared after `Deny`, reappeared after `Retry`, and disappeared after `Allow`. The user's regular Chrome was not attached, quit, restarted, or modified.

## Onboarding visual and native permission evidence

Task 6 verified the three-step onboarding UI against the production extension, the Vite development server, and a separate headed release-build launch. The longest bundled domain, `store.steampowered.com`, is the long-value boundary because onboarding deliberately offers bundled category choices rather than custom-domain entry.

- [x] `npx vitest run tests/unit/onboarding/theme-entry.test.ts` passed all 6 tests. Saved Light and Dark themes load through the validated settings message boundary, invalid or failed loads retain Auto, and valid live snapshots update the onboarding theme.
- [x] `npm run build && npx playwright test tests/e2e/onboarding-visual.spec.ts` passed the production visual scenario in an isolated Chrome-for-Testing profile. It captured every seeded state at 375, 768, and 1280 px in Auto with light media, Auto with dark media, explicit Light with dark media, and explicit Dark with light media.
- [x] Production coverage includes all three steps, an expanded Gaming category, the permission explanation, denied access, registration failure, Retry, Not now, Sync on and off, pending completion, invalid-draft recovery, and load-error recovery. The run captured 324 full-page, heading, and focused-component PNGs. It reported zero overflow, clipping, console errors, page errors, worker errors, request failures, and blocked requests.
- [x] The Vite development-server pass exercised all three steps at the same three widths and four theme/media combinations. It captured 72 full-page and focused-component PNGs across 36 states. Computed colors, explicit-theme precedence, viewport edges, long-domain wrapping, and browser diagnostics passed.
- [x] Representative full-page and focused captures were inspected at every width and in light and dark presentations. Headings, expanded lists, warning and recovery messages, button rows, the Sync switch, disabled pending-completion action, focus outlines, and viewport edges remained readable and contained.

Chrome-for-Testing 151.0.7922.34 displayed these exact browser-owned lines after the real `Enable website blocking` click:

- `"Focus Lock" has requested additional permissions.`
- `It could:`
- `Read and change all your data on all websites`
- `Deny`
- `Allow`

The onboarding explanation says `Chrome will therefore ask whether Focus Lock may read and change data on all websites.` Chrome inserts `your` in its capability line. The scope matches line by line: read and change access, all data, and all websites. The surrounding onboarding copy additionally limits the product's stated use to checking addresses, applying blocking rules, and restoring pages.

Task 6 artifacts:

- Production visual evidence: `test-results/onboarding-visual-producti-6c3bf-it-every-viewport-and-theme/onboarding-visual-evidence/`
- Development-server evidence: `~/.dev-browser/tmp/task6/`
- Native prompt before click: `test-results/task6-real-prompt/permission-step-before-click.png`
- Native browser-owned prompt: `test-results/task6-real-prompt/real-permission-prompt.png`
- Native prompt after denial: `test-results/task6-real-prompt/after-deny.png`
- Native prompt after grant: `test-results/task6-real-prompt/after-grant.png`

Task 5 artifacts are in `test-results/`:

- `test-results/.last-run.json`
- `test-results/onboarding-fresh-install-h-1fd80--routes-to-unfinished-setup/`
- `test-results/onboarding-denied-access-c-23193-cally-and-block-a-real-page/`
- `test-results/onboarding-sync-completion-f5095-n-survive-a-browser-restart/`
- `test-results/onboarding-permission-revo-bebe5-jects-another-session-start/`
- `test-results/onboarding-quota-backed-fi-cfc63-rowser-restart-then-retries/`
- `test-results/onboarding-setup-completio-b9e30-l-load-and-step-transitions/`
- `test-results/restart-persistent-profile-88b20-ve-countdown-after-relaunch/`

Playwright retains traces only on failure. The passing integrated run therefore records isolated profiles and `.last-run.json`, not a green trace archive.

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
