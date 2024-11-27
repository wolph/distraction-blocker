# Focus Lock QA checklist

Last updated: 2026-08-29.

Checked items were confirmed by the Playwright extension suite or an isolated Chrome for Testing profile. Unchecked items have not been confirmed. The isolated profile did not touch the user's Chrome.

## Automated real-browser checks

- [x] The Manifest V3 worker loads and answers requests from an extension page.
- [x] The popup root renders.
- [x] A local blockable test page loads while no session is active.
- [x] A fresh blocked navigation stops before page content renders, uses an opaque locked document, and sets a locked title.
- [x] A page open before the session receives an overlay and mute state without navigation or reload. Its form value and JavaScript heap state survive, and mute state clears after completion.
- [x] A stopped navigation reloads after the session and renders its requested page.
- [x] A single-page app history change into a blocked URL receives the overlay without a reload.
- [x] A blocked media tab receives Chrome tab mute state.
- [x] An early pause confirmation is rejected by the worker. Confirmation succeeds only after the worker timestamp is ready, enters the paused phase, and removes the page overlay.
- [x] Leaving a gate records a resisted temptation.
- [x] A hard session rejects a list change that would weaken the active lock.
- [x] Friction cancellation waits until its worker timestamp, rejects the wrong phrase, and accepts the exact intention-derived phrase.
- [x] An overlay unlock from a subdomain normalizes to its registrable host and removes that page's overlay.
- [x] The toolbar badge has countdown text during focus and clears after completion.
- [x] Settings, lists, pause bank, streak, and aggregate data use `chrome.storage.sync`. Runtime and events remain local. Every sync item stays within Chrome's reported per-item quota.
- [x] An enabled schedule whose window includes the current local time starts a scheduled focus session.

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
## Manual Chrome checks

- [ ] Load the unpacked build through Chrome's extension-management UI, pin it, and verify the exact gray open-padlock idle icon. The isolated extension was loaded by automation, but toolbar pinning and exact Chrome UI icon visuals were not inspected.
- [ ] Enable Social, start a 15-minute friction session, and check fresh `facebook.com` plus an existing `x.com` tab. Local controlled pages verified the blocking, overlay, state preservation, and Chrome mute property. Public-site presentation and audible silence were not manually checked.
- [ ] Watch the pause gate count down, choose Back to work, then take a pause. Verify the amber ring, global unblock, and Resume now behavior. Worker transitions are automated, but the full visual flow was not inspected.
- [ ] Unlock one site and confirm other blocked sites remain locked. Registrable-host normalization and the selected overlay removal are automated, but a multi-site manual pass was not completed.
- [ ] Let a normal session complete and verify the happy chime, visible notification, overlay removal with scroll position intact, stopped-tab reload, and gray idle icon. Page preservation and reload are automated. Sound, notification visibility, scroll position, and final icon visuals remain manual.
- [x] The stats page renders the day's focus, attempts, resisted gates, pause spending, charts, recent sessions, streak, and freezes in light and dark themes at all three inspected widths.
- [ ] During a hard session, verify the options banner, a readable rejection when removing a rule, and successful addition of a stricter rule. The weakening rejection is automated, but the options UI flow was not visually checked.
- [ ] Turn on Allow in Incognito and confirm an incognito tab is blocked. This requires a manual toggle in Chrome's extension-management UI.
- [ ] Use two Chrome profiles signed into the same Google account and confirm settings plus a prior-day aggregate arrive after sync. This requires two signed-in profiles and live Google sync.
- [ ] Relaunch the isolated Chrome profile during a session and confirm the session, overlay, and countdown recover. An isolated persistent-profile check restored the session, countdown, tab, and content-script receiver, but the overlay did not remount. The attempted restart-path fixes did not resolve that race and were removed.
- [ ] Listen to session-complete, break-start, break-end, and schedule-start chimes. Automated code can request and preview them, but it cannot make a safe hearing assertion.
- [ ] Confirm a Focus Lock notification is visible in the operating system. Notification delivery was not manually observed.

## Local screenshot artifacts

These artifacts are outside the repository under `~/.dev-browser/tmp/`:

- `popup-idle-light-1280.png`
- `popup-idle-light-1280-component.png`
- `popup-idle-light-768.png`
- `popup-idle-light-768-component.png`
- `popup-idle-light-375.png`
- `popup-idle-light-375-component.png`
- `popup-idle-dark-1280.png`
- `popup-idle-dark-1280-component.png`
- `popup-idle-dark-768.png`
- `popup-idle-dark-768-component.png`
- `popup-idle-dark-375.png`
- `popup-idle-dark-375-component.png`
- `popup-idle-light-375-focus-hover.png`

The fresh full visual pass is under

- `~/workspace/distraction-blocker/.playwright-mcp/qa-final/master-5799bf9-final4/` with 74 PNG captures and `qa-report.json`
- `~/workspace/distraction-blocker/.playwright-mcp/qa-final/post-fix-targeted/` with 6 post-fix PNG captures and `qa-report.json`

Both directories are untracked QA artifacts and are not part of the extension build.
