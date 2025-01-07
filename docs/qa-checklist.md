# Focus Lock QA checklist

Last updated: 2026-08-29.

Checked items were confirmed by automated tests or an isolated Chrome for Testing profile. Unchecked items have not been confirmed. The isolated profile did not touch the user's Chrome.

## Automated real-browser checks

- [x] The Manifest V3 worker loads and answers requests from an extension page.
- [x] The popup root renders.
- [x] The action badge shows a countdown during focus and clears when the session completes.
- [x] A local blockable test page loads while no session is active.
- [x] A fresh blocked navigation stops before page content renders, uses an opaque locked document, and sets a locked title.
- [x] A page open before the session receives an overlay and mute state without navigation or reload. Its form value and JavaScript heap state survive, and mute state clears after completion.
- [x] A stopped navigation reloads after the session and renders its requested page.
- [x] A single-page app history change into a blocked URL receives the overlay without a reload.
- [x] A blocked media tab receives Chrome tab mute state.
- [x] An early pause confirmation is rejected by the worker. Confirmation succeeds only after the worker timestamp is ready, enters the paused phase, and removes the page overlay.
- [x] The popup pause flow exposes Never mind, back to work, enables Take pause only after the gate delay, enters the paused phase, and resumes focus through Resume now. The controlled page overlay follows each phase.
- [x] Leaving a gate records a resisted temptation.
- [x] During a hard session, Options shows the active-lock banner and a readable rejection when a blocked rule is removed. Adding a stricter rule through the same UI saves successfully.
- [x] Friction cancellation waits until its worker timestamp, rejects the wrong phrase, and accepts the exact intention-derived phrase.
- [x] An overlay unlock from a subdomain normalizes to its registrable host and removes only that registrable site's overlay. A second blocked site stays locked, and the selected site reblocks after the unlock expires.
- [x] Settings, lists, pause bank, streak, and aggregate data use `chrome.storage.sync`. Runtime and events remain local. Every sync item stays within Chrome's reported per-item quota.
- [x] An enabled schedule whose window includes the current local time starts a scheduled focus session, sends the schedule-start sound message through the offscreen audio path, and creates a notification visible through the notification API.

## Live visual and interaction checks

- [x] Popup idle light and dark themes were inspected at 1280 px, 768 px, and 375 px, including component crops and the 375 px focus and hover capture.
- [x] Popup active light and dark themes were inspected at the native 340 px popup width and 375 px. Captures include the full component, ring, budget meter, actions, hover, and keyboard focus.
- [x] Existing-tab and stopped-document overlays were inspected in light and dark themes at 1280 px, 768 px, and 375 px with component crops. The stopped document is opaque and titled `Locked - Focus Lock`.
- [x] Gate dialog light and dark themes were inspected at 1280 px, 768 px, and 375 px with component crops.
- [x] Options light and dark themes were inspected at 1280 px, 768 px, and 375 px with component crops, hover, and keyboard focus. The post-fix 375 px pass has zero horizontal overflow.
- [x] Stats light and dark themes were inspected at 1280 px, 768 px, and 375 px with component crops, hover, and keyboard focus.
- [x] Options text contrast meets 4.5:1 in the post-fix pass. The measured ratios are 4.824:1 for light current navigation, 5.584:1 for light primary buttons, 6.222:1 for dark current navigation, and 7.135:1 for dark primary buttons.
- [x] An affordable overlay no longer shows or exposes stale `ready in 0:00` text. Its exact button accessibility labels were verified in both themes.
- [x] Popup, overlay, gate, options, and stats console checks reported zero errors. The post-fix pass also recorded zero page errors, worker errors, request failures, and blocked requests.
## Additional automated and isolated-browser checks

- [x] Normal completion removes an existing-page overlay without reloading its form or JavaScript state, preserves its exact nonzero scroll position, reloads a stopped navigation to its requested body, and clears the action badge. A short cycling session sends break-start, break-end, and session-complete sound messages through the offscreen audio path. `chrome.notifications.getAll()` exposes the completion notification.
- [x] The stats page renders the day's focus, attempts, resisted gates, pause spending, charts, recent sessions, streak, and freezes in light and dark themes at all three inspected widths.
- [x] The Playwright restart test closes and relaunches the same isolated persistent Chromium profile mid-session. It preserves the active focus phase, `startedAt`, and `phaseEndsAt`. The positive countdown decreases, the popup renders `focusing` with its clock, the stopped document ID matches the live main-frame document, the locked overlay and title recover, and the tab remains muted by the extension. On completion, the overlay clears, the requested body reloads, the tab returns to its prior unmuted state, extension-owned mute clears, and runtime tab state is removed.

## Manual-only external checks

- [ ] Pin the extension and confirm the exact browser-chrome toolbar icon presentation. Automated checks cover badge text, but Chrome's pinned-toolbar pixels remain outside the extension page.
- [ ] Confirm blocking in an incognito tab if the per-extension permission can be enabled safely in an isolated Chrome profile.
- [ ] Confirm settings and a prior-day aggregate propagate between two Chrome profiles signed into the same Google account with extension sync enabled.
- [ ] Listen to the session-complete, break-start, break-end, and schedule-start synthesized sounds and confirm them by human hearing.
- [ ] Confirm operating-system notifications are visible outside the isolated browser environment. Automated checks cover the notification API request only.
- [ ] Confirm that the untracked `key.pem` has an external backup in a password manager or synced secret store. The repository can verify only its ignore rule and matching public key.

## Curated repository screenshots

- `docs/images/focus-lock/popup-active.png`
- `docs/images/focus-lock/overlay.png`
- `docs/images/focus-lock/gate.png`
- `docs/images/focus-lock/options.png`
- `docs/images/focus-lock/stats.png`

The full QA capture directories under `.playwright-mcp/qa-final/` remain untracked and are not part of the extension build.
