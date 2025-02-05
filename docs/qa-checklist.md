# Focus Lock QA checklist

Last updated: 2026-08-30.

Checked items were confirmed by automated tests or isolated Chrome-for-Testing profiles. Unchecked items require an external observation. The isolated profiles did not touch the user's Chrome. Browser and automated evidence targets source commit `de60068`. Curated screenshots were committed in `0ed0c27`.

## Final automated gates

- [x] `NO_COLOR=1 npm run check` passed 39 test files with 788 tests passed and 2 skipped. Biome, TypeScript, deterministic icon generation, and the production build passed.
- [x] `NO_COLOR=1 npm run e2e` passed all 23 Playwright scenarios in isolated Chrome-for-Testing profiles.
- [x] The restart scenario closed and relaunched the same isolated persistent profile. It preserved the active focus phase, timer fields, stopped document identity, locked overlay, and extension-owned mute state. Completion restored the requested page and prior mute state.
- [x] Settings, lists, pause bank, streak, and aggregate data use `chrome.storage.sync`. Runtime state and events remain local.
- [x] Every Sync item stays within Chrome's per-item quota. Projected writes also stay within the 100 KB total quota by removing or omitting the oldest monthly aggregate items first.

## Automated browser behavior

- [x] The Manifest V3 worker loads and answers extension-page requests. Popup, Options, and Stats pages render.
- [x] A local blockable page loads while no session is active.
- [x] Fresh blocked navigation stops before page content renders. It shows an opaque overlay titled `Locked - Focus Lock`.
- [x] A page opened before a session receives the overlay and extension-owned mute state without navigation or reload. Its form value, JavaScript heap state, and scroll position survive completion.
- [x] A stopped navigation reloads its requested page when blocking ends.
- [x] Single-page app navigation into a blocked URL receives the overlay without a reload.
- [x] Pause confirmation is rejected before the worker timestamp. After the delay, pause and resume update the controlled page.
- [x] Leaving a gate records a resisted temptation.
- [x] Friction cancellation rejects the wrong phrase and accepts the exact intention-derived phrase after the worker delay.
- [x] A subdomain unlock normalizes to its registrable host. It unlocks only that site, leaves a second site blocked, and reblocks after expiry.
- [x] A hard session shows the Options lock banner, rejects a weakening change with readable text, and accepts a stricter rule.
- [x] A short cycling session requests break-start, break-end, and session-complete sounds through the offscreen audio path.
- [x] An active schedule requests the schedule-start sound and creates a notification visible through `chrome.notifications.getAll()`.
- [x] The action badge shows the focus countdown and clears after completion.

## Visual interaction checks

- [x] Popup idle and active states were inspected in light and dark themes at 1280 px, 768 px, 375 px, and the native 340 px popup width where applicable.
- [x] Existing-page and stopped-document overlays were inspected in light and dark themes at 1280 px, 768 px, and 375 px.
- [x] The gate, Options, and Stats pages were inspected in light and dark themes at 1280 px, 768 px, and 375 px.
- [x] Component crops cover rings, budget meters, actions, the hard-session banner and rejection, Options navigation, and the Stats Pause and Unlock columns.
- [x] Hover, keyboard focus, text rendering, spacing, and overflow were checked. No inspected page had horizontal overflow.
- [x] Options navigation and primary buttons meet the 4.5:1 contrast target. Measured ratios range from 4.824:1 to 7.135:1 across the inspected light and dark states.
- [x] The exact visual pass produced 129 artifacts. It recorded zero console, page, worker, request, and blocked-request errors. Three expected shutdown-only worker messages were recorded separately.
- [x] The extension was pinned in isolated Chrome-for-Testing 151.0.7922.34. During a seeded break with the countdown badge disabled, the browser toolbar showed a teal closed lock, a progress-ring outline, and a cup mark.

## Manual-only external checks

- [ ] Confirm settings and a prior-day aggregate propagate between two Chrome profiles signed into the same Google account with extension Sync enabled.
- [ ] Listen to the session-complete, break-start, break-end, and schedule-start sounds and confirm them by human hearing.
- [ ] Confirm operating-system-visible notifications outside the isolated browser environment.
- [ ] Confirm blocking in an incognito tab when the per-extension permission can be enabled safely in an isolated profile.
- [ ] Confirm the untracked `key.pem` has an external backup.

## QA artifacts

The exact visual report is `.playwright-mcp/qa-final/master-de60068c-exact/qa-report.json`. The pinned-toolbar screenshot and crop are under `.playwright-mcp/qa-final/toolbar-break-0ed0c275-1788052452918/`. These full QA capture directories remain untracked.

Curated repository screenshots:

- `docs/images/focus-lock/popup-active.png`
- `docs/images/focus-lock/overlay.png`
- `docs/images/focus-lock/gate.png`
- `docs/images/focus-lock/options.png`
- `docs/images/focus-lock/stats.png`
