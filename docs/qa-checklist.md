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

Task 6 verified the three-step onboarding UI from initial implementation commit `a5677ad`, permission-copy fix commit `c39029868c79e5dad1ced2ce99ff36de10493f24`, evidence-integrity fix commit `ed37f9848c5278ca1d550dc583647e26218201cd`, and verifier and observation fix commit `fa6a34d5409da610f80089213ffa1b0302dd4ab7`. The checks covered the production extension, the Vite development server, and a separate headed release-build launch. The longest bundled domain, `store.steampowered.com`, is the long-value boundary because onboarding deliberately offers bundled category choices rather than custom-domain entry.

- [x] `npx vitest run tests/unit/onboarding/theme-entry.test.ts tests/unit/onboarding/visual-evidence-manifest.test.ts` passed all 9 tests. Saved Light and Dark themes load through the validated settings message boundary, invalid or failed loads retain Auto, valid live snapshots update the onboarding theme, dark media gets its dark palette before the Auto attribute is applied, manifests hash only real PNG payloads, and false PNG filenames are rejected.
- [x] `npm run build` followed by `FOCUS_LOCK_E2E_DIST=<isolated-build> npx playwright test tests/e2e/onboarding-visual.spec.ts` passed the production visual scenario in 28.9 seconds in an isolated Chrome-for-Testing profile. It captured every seeded state at 375, 768, and 1280 px in Auto with light media, Auto with dark media, explicit Light with dark media, and explicit Dark with light media. The isolated build prevents another workstream's build from removing shared `dist/` files during the run.
- [x] Production coverage includes all three steps, an expanded Gaming category, the exact permission explanation, denied access, registration failure, Retry, Not now, Sync on and off, pending completion, invalid-draft recovery, and load-error recovery. The run captured 372 full-page, heading, explanation, list, error, button, and switch PNGs. It reported zero overflow, clipping, console errors, page errors, worker errors, request failures, and blocked requests.
- [x] The production manifest makes no blanket no-mock claim. It records two scoped `chrome.runtime.sendMessage` interceptions: 12 observed `completeOnboarding` calls held pending for the pending-completion UI, and 12 observed first `getSetupState` calls failed for the load-error and successful Retry UI. A page binding was exposed before wrapper injection. Each wrapper called it only after matching the exact state and request type, and the test waited for the callback before capture. Manifest totals derive only from those callback records. A regression confirms that visible pending or error UI without a callback leaves both totals at zero. Every other call passed through to the real extension.
- [x] The E2E fixture resolves the extension build once with precedence explicit override, `FOCUS_LOCK_E2E_DIST`, then repository `dist/`. It passes that resolved build to production, temporary permission-grant, and restart launches. The environment-only grant-dist regression copied a unique marker and produced the required-permission manifest without reading repository `dist/`. The isolated-environment Chromium grant scenario then retried denied access, completed setup, and blocked a real page.
- [x] `npx vitest run tests/unit/onboarding/visual-evidence-manifest.test.ts tests/unit/e2e/extension-dist.test.ts tests/unit/onboarding/qa-evidence-verifier.test.ts` passed 21 tests. The archive adversarial cases reject duplicate, unexpected, traversal, symlink, hardlink, FIFO, block-device, character-device, socket, other special, declared-size mismatch, compressed oversize, per-file oversize, excess-member, and expanded-size inputs before extraction.
- [x] The fix verification rebuilt the extension and passed `FOCUS_LOCK_E2E_DIST=<isolated-build> npx playwright test tests/e2e/onboarding-visual.spec.ts` in 23.9 seconds. The separate environment-selected permission-grant scenario passed in 5.1 seconds. Scoped Biome, TypeScript, JavaScript syntax, the portable verifier, and all archive and standalone-manifest hashes passed. The tracked archives and manifests retained their documented hashes.
- [x] The Vite development-server pass exercised the same 9 states in 108 state, theme, and viewport configurations. It captured 528 full-page, heading, list, explanation, error, button, switch, and viewport-edge PNGs. Computed colors, explicit-theme precedence, viewport containment, `store.steampowered.com` wrapping, the real `Not now` transition, load-error Retry, and browser diagnostics passed. This pass used an in-page Chrome API mock only to seed visual states.
- [x] Representative full-page and focused captures were inspected at every width and in light and dark presentations. Headings, expanded lists, warning and recovery messages, button rows, the Sync switch, disabled pending-completion action, focus outlines, and viewport edges remained readable and contained.

Chrome-for-Testing 151.0.7922.34 displayed these exact browser-owned lines after the real `Enable website blocking` click:

- `"Focus Lock" has requested additional permissions.`
- `It could:`
- `Read and change all your data on all websites`
- `Deny`
- `Allow`

The onboarding explanation now reproduces Chrome's capability line exactly: `Read and change all your data on all websites`. No material capability is omitted. The surrounding onboarding copy additionally limits the product's stated use to checking addresses, applying blocking rules, and restoring pages.

Task 6 artifacts:

- Portable evidence instructions and verifier: `docs/qa-artifacts/onboarding-task6/README.md` and `docs/qa-artifacts/onboarding-task6/verify.mjs`. Run `node docs/qa-artifacts/onboarding-task6/verify.mjs` on macOS or Linux. Before extraction, it validates the exact flat member set, member types, declared sizes, duplicates, paths, and compressed, count, per-file, and total-expanded safety bounds. Extraction disables owner and permission restoration.
- Development-server archive: `docs/qa-artifacts/onboarding-task6/archives/e9212cbda6e84f19b8f4d998eba719380ea1faf9e4ab8517c18c67c2e7d98a7b.tar.gz`, 16,585,380 bytes, SHA-256 `e9212cbda6e84f19b8f4d998eba719380ea1faf9e4ab8517c18c67c2e7d98a7b`. Its standalone manifest is `docs/qa-artifacts/onboarding-task6/manifests/dev-server-manifest.json`, SHA-256 `3cbe2e5ed8bffd35cadf591a9b0d9722f897c039d85ad2cf6d9048c5f44ac13b`.
- Production archive: `docs/qa-artifacts/onboarding-task6/archives/aefeeec2f37b11a342bf392d5df957cebb08f6fb20409a60ecad046b31233d4c.tar.gz`, 8,950,366 bytes, SHA-256 `aefeeec2f37b11a342bf392d5df957cebb08f6fb20409a60ecad046b31233d4c`. Its standalone manifest is `docs/qa-artifacts/onboarding-task6/manifests/production-manifest.json`, SHA-256 `aff6785cf48b23e285f619a62af58c8bfc67e242fbfaff8992af84e8680d0d39`.
- Real browser-chrome evidence: `docs/qa-artifacts/onboarding-task6/real-prompt/` and `docs/qa-artifacts/onboarding-task6/manifests/real-prompt-manifest.json`, whose manifest SHA-256 is `041a35f7e8581bec4505e83c7b99f7c73ae4622b237b80d1dc218833e811acb9`. All six `.png` files contain PNG image data.

The real prompt used headed Chrome-for-Testing 151.0.7922.34, unpacked production `dist/`, and the fresh isolated profile `/tmp/focus-lock-task6-prompt-final.7b0q5P`. Computer Use clicked the real extension controls and Chrome's browser-owned sheet. No Chrome API or prompt mock was used. The user's regular Chrome was not targeted or modified.

- Before click: `docs/qa-artifacts/onboarding-task6/real-prompt/permission-step-before-click.png`, 156,264 bytes, SHA-256 `350d20fa62932c604c4ce4de100130097667c548c31fd56df871bd08400eb04f`.
- After click: `docs/qa-artifacts/onboarding-task6/real-prompt/real-permission-prompt.png`, 29,630 bytes, SHA-256 `60c458beff58b53faca4aedfd3fc8e06b0b9a020e1a56875ed615ef33df55048`.
- After denial: `docs/qa-artifacts/onboarding-task6/real-prompt/after-deny.png`, 157,926 bytes, SHA-256 `a5b188078919c6da28d300ec77a7956fcbecf2fd624e526eb1fe9997367d46bb`.
- After Retry: `docs/qa-artifacts/onboarding-task6/real-prompt/after-retry.png`, 29,630 bytes, SHA-256 `60c458beff58b53faca4aedfd3fc8e06b0b9a020e1a56875ed615ef33df55048`.
- After grant: `docs/qa-artifacts/onboarding-task6/real-prompt/after-grant.png`, 155,471 bytes, SHA-256 `295963316595cb4d80a291297baa8994780a4695c8b9f76ad89f1997bfe0f9ef`.

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

## Daily product surface evidence

Task 7 verified the integrated daily-use Popup, Options, Stats, gate, existing-page overlay, stopped-document overlay, and Privacy surfaces on 2026-09-01. The run used isolated headless Chrome-for-Testing 151.0.7922.34 profiles. It did not attach to, close, restart, or modify the user's regular Chrome. The category separator correction is commit `fb95ed746bdda7ed86556e13ebfddab366ea77aa`. The clean save-bar correction is commit `c2f9dbf8dc10ac12e94420c507088c7c97a4e6c9`. Commit `bf70b93743917efd20b842fda67d67a4fc3b4026` reserves a separate internal-scroll content row for dirty, pending, and error save bars, so no sticky state covers visible category content. Commit `26126a6f4ff04647eaced56fb7753aa16e2560e9` serializes persisted snapshot reads behind admitted policy mutations, so test teardown cannot interrupt schedule-alarm journal work after observing an early snapshot.

- [x] The first focused Options geometry assertion failed at 375 px because every collapsed `.category-state` started 6 px above its preceding `.cat-row` bottom border. Changing `.category-state` from `margin: -6px 0 10px 28px` to `margin: 0 0 10px 28px` made the assertion pass. The historical RED capture is excluded from the exact current inventory. The reproducible GREEN capture is `artifacts/daily-product-surfaces-task7/task7-dev-current-options-auto-light-375-partial-dirty-full.png`.
- [x] The reproducible development command is `TASK7_DEV_EVIDENCE_DIR=artifacts/daily-product-surfaces-task7 node scripts/capture-task7-dev-evidence.ts`. It starts strict-port Vite from source modules and launches Playwright's bundled Chromium, not regular Chrome. Readiness requires both the owned Vite child's ready output and a successful response, so an unrelated listener on port 4177 cannot be mistaken for the harness. It captures an exact 320-file set: 56 native-340 Popup, 72 Options, 72 Privacy, 24 overlay provenance, and 96 current Stats, typed and untyped gate, and stopped-overlay PNGs. `task7-dev-current-run-report.json` inventories every development PNG with SHA-256, byte size, complete PNG dimensions, source, theme, media, viewport, surface, state, scope, exact-copy assertions, and per-file diagnostics. The generator rejects duplicate, missing, unexpected, or incomplete development records.
- [x] The native 340 px Popup evidence covers block mode, allow mode, focused invalid-domain feedback, long internal rule-list scrolling and focus, Flexible hover help, Friction keyboard-focus help, Hard lock click help, all three session types, and the unsupported-tab disabled reason. The development rerun added full and focused Hard lock click captures plus full and focused unsupported-tab captures in all four theme and media cases. The document stayed at 340 px. The rule region scrolled internally with `clientWidth` equal to `scrollWidth`. No help popover, list, action, or error escaped the viewport.
- [x] Development overlay provenance was recaptured full-page and focused at 375, 768, and 1280 px across all four theme and media cases. All 12 Chrome DevTools Protocol accessibility checks found exactly one Focus Lock overlay. Every overlay host matched its viewport bounds.
- [x] The expanded production extension matrix contains 356 full-page and focused captures from a fresh isolated build of application-source commit `26126a6f4ff04647eaced56fb7753aa16e2560e9`. Popup ran at 340 px. Options, Privacy, Stats, typed and untyped gates, and both overlay forms ran at 375, 768, and 1280 px as applicable. Every surface ran in all four theme and media cases. The matrix covers long-list focus, Flexible hover, Friction focus, Hard lock click, invalid-domain error focus, category-off focus, a partial category, clean, dirty, pending, and error save bars, a real quota-backed durable Sync error, both Privacy confirmations, unsupported-tab reason, current Stats language, typed and untyped cancellation, overlay provenance, and the stopped-document message. Force-end absence is asserted in every typed and untyped gate record instead of producing redundant screenshots. The normal no-environment-variable matrix executed every assertion, passed 1 scenario in 55.3 seconds, and wrote only to the Playwright per-test output directory.
- [x] The persistent production command passed twice against the same immutable build, first in 48.4 seconds and then in 51.5 seconds: `FOCUS_LOCK_E2E_DIST=<isolated-build> TASK7_EVIDENCE_DIR=artifacts/daily-product-surfaces-task7 NO_COLOR=1 npx playwright test tests/e2e/qa-flows.spec.ts --grep "Task 7 production evidence matrix" --reporter=line`. Evidence mode rejects repository `dist/`, missing provenance, dirty application source, application-source commit or tree mismatches, and before-to-after build mutation. The report records application-source SHA-256 `776753c3b57b0649254383012a3f6981b72a7b1324d666a1cf3e26f44263e14a`, dist-tree SHA-256 `669732aad70b3ba7eb146ee115d049eb5683192c749694e3b38ed4df8d9dce22`, and built-manifest SHA-256 `41932cb819617ee6bdaeb0d97ecbeedd6b3ceb315bb2d6832579e4f32f433e86`, unchanged before and after capture. Its owned-context-closed audit contains zero unexpected console, page, worker, request, or blocked-request diagnostics. Shutdown-only messages use an any-count exact-allowlist policy because teardown timing makes their count non-deterministic. Zero, two, three, and five have been observed. Every normalized message must exactly equal `focus-lock background error Error: The browser is shutting down.` The latest report stores count 0 and the complete empty message list. Changed or unclassified text fails.
- [x] Computed theme assertions verify resolved `color-scheme`, page background, and text colors. Auto follows emulated light or dark media. Explicit Light and Dark override the opposite emulated media. Popup, Options, Privacy, Stats, gate, existing-overlay, and stopped-overlay cases passed.
- [x] The production Options report contains 84 category row-to-state gap samples, all exactly 0 px. In all 12 theme and viewport cases, clean save bars were static. Dirty, pending, and error bars occupied a separate sticky layout row. The clipped-visible geometry scan checks every visible heading, paragraph, status, alert, action, input, category row, and category state and recorded zero intersections in all states.
- [x] The real projected total-quota regression fills only test-owned Sync keys, verifies the native 102,400-byte rejection response, waits for the durable error state, preserves the expanded local policy, verifies stored Sync bytes remain within quota, and removes filler in `finally`.
- [x] `artifacts/daily-product-surfaces-task7/evidence-manifest.json` inventories every evidence file except itself, records SHA-256 and byte size for each file, validates all eight PNG signature bytes, records exact image dimensions and state metadata for each PNG, and cross-checks exact set parity for all 320 development and 356 expanded production captures. Duplicate inventory entries and any missing or unexpected image fail generation. The diagnostics contract accepts any number of exact allowlisted shutdown duplicates, including zero, and rejects changed or unclassified messages. The no-self-hash rule is explicit in the manifest. The 3 inventoried support artifacts and the manifest pass the project formatter.
- [x] The focused diagnostics, evidence-runner, safe-output, and engine regression run passed 208 tests across 4 files. The scoped immutable-build `qa-flows.spec.ts` and `system.spec.ts` run passed all 12 scenarios in 1.9 minutes. The schedule scenario also passed 10 consecutive isolated repetitions in 23.0 seconds with clean fixture teardown diagnostics.
- [x] `NO_COLOR=1 npm run check` passed 82 test files with 1,985 tests passed and 2 skipped. Biome checked 256 files. TypeScript, deterministic icon generation, and the production build passed.
- [x] The current integrated `NO_COLOR=1 npm run e2e` rebuilt the extension and passed all 45 scenarios in 6.2 minutes. Commit `537ed1a71d7f6ad70ca2c28469bdf94d62cdf969` fixed the paused-session timeout root cause: the engine scheduled the next wake from the paused phase end even when the session wall clock ended first. It now schedules the earlier of phase and session end. A unit regression asserts the exact wake time, and the browser regression verifies paused UI leaves when the wall-clock session end arrives.

Task 7 contains 685 PNG files, 3 inventoried support artifacts, and the self-excluded manifest in `artifacts/daily-product-surfaces-task7/`. The screenshots comprise 320 reproducible development captures and 365 production captures, including the original 9 critical production captures and the expanded 356-capture production matrix. Representative evidence:

- Development Hard lock click detail: `task7-dev-current-popup-<theme-case>-340-hard-click-full.png` and matching `-focused.png` files.
- Development unsupported-tab reason: `task7-dev-current-popup-<theme-case>-340-unsupported-tab-full.png` and matching `-focused.png` files.
- Development Options and Privacy: `task7-dev-current-options-<theme-case>-<375|768|1280>-<state>-<full|focused>.png` and `task7-dev-current-privacy-<theme-case>-<375|768|1280>-<state>-<full|focused>.png`.
- Development overlay provenance: `task7-dev-current-overlay-<theme-case>-<375|768|1280>-provenance-full.png` and matching `-focused.png` files.
- Expanded production Popup: `task7-production-popup-<theme-case>-340-<state>-<full|focused>.png`.
- Expanded production Options: `task7-production-options-<theme-case>-<375|768|1280>-<state>-<full|focused>.png`.
- Expanded production Privacy and overlay: `task7-production-privacy-<theme-case>-<375|768|1280>-<state>-<full|focused>.png` and `task7-production-overlay-<theme-case>-<375|768|1280>-provenance-<full|focused>.png`.
- Current Stats: `task7-<dev-current|production>-stats-<theme-case>-<375|768|1280>-current-language-<full|focused>.png`.
- Current gate states: `task7-<dev-current|production>-gate-<theme-case>-<375|768|1280>-<typed-gate|untyped-gate>-<full|focused>.png`.
- Current stopped-document overlay: `task7-<dev-current|production>-stopped-overlay-<theme-case>-<375|768|1280>-stopped-document-<full|focused>.png`.
- Machine-readable audit: `evidence-manifest.json`, `production-run-report.json`, and `task7-dev-current-run-report.json`.

## Automated browser behavior

- [x] The Manifest V3 worker loaded and answered extension-page requests. Popup, Options, Stats, content overlay, stopped-document overlay, and gate surfaces rendered.
- [x] Fresh blocked navigation stopped before page content rendered. Existing pages were overlaid and muted without reload. Session completion restored page state and cleared browser effects.
- [x] Pause, unlock, abandon, and cancellation gates used the configured delay and optional typing requirement. Gate choices include 0, 10, 30, and custom whole seconds. A 0-second delay still required the configured typed phrase. Typing-off cancellation accepted no phrase after the configured delay. Typing-on cancellation rejected missing and inexact phrases. A single-site unlock left another site blocked and reblocked after expiry.
- [x] The removed `Ignore timeout and end anyway` bypass is absent from current typed and untyped Friction gates. Flexible sessions end directly. Hard sessions expose no end action and remain non-cancellable.
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
- [x] Existing-page overlay, stopped-document overlay, typed and untyped gates, Options, and Stats surfaces were inspected in all four theme and media cases at 1280 px, 768 px, and 375 px. Force-end absence is recorded as metadata on every typed and untyped gate capture.
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
- [x] Shutdown-only worker messages are classified as `expected-browser-shutdown` under the explicit `any-count-exact-allowlist` policy. The actual count and complete normalized message list are stored for every production run. Any count, including zero, is valid only when every message exactly equals `focus-lock background error Error: The browser is shutting down.` The latest report recorded zero. Changed or unclassified text remains an error.

## Manual-only checks

- [ ] Confirm Chrome Sync across two signed-in profiles.
- [ ] Hear session-complete, break-start, break-end, and schedule-start sounds through real speakers.
- [ ] Confirm operating-system-visible notifications outside the isolated browser environment.
- [ ] Confirm blocking in an incognito tab after enabling the per-extension permission in a safe isolated profile.
- [ ] Confirm the untracked `key.pem` has an external backup.

## Historical pre-redesign QA artifacts

The following `.playwright-mcp` directory predates the public-launch redesign and is retained for history only. It is not completion evidence for current Stats, gate, or stopped-document surfaces. Current Task 7 evidence is under `artifacts/daily-product-surfaces-task7/`.

The historical evidence directory is `.playwright-mcp/qa-final/master-c87383f1-exact-1788116604430/`.

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
