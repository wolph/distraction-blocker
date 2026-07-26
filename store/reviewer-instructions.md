# Chrome Web Store reviewer instructions

No account, payment, external service, or test credential is required. The extension works with ordinary public HTTP and HTTPS pages.

## Install and complete onboarding

1. Install the submitted Focus Lock package in Chrome. On a new profile, the onboarding page opens automatically. If it does not, click the Focus Lock toolbar icon and choose Open setup.
2. On Choose your starting block list, enable Social media and choose Continue.
3. On Enable website blocking, choose Enable website blocking. Approve Chrome's Read and change all your data on all websites prompt. The permission is optional at installation and requested here because the selected rules can cover any HTTP or HTTPS website.
4. On Choose where your settings are stored, leave Sync across Chrome devices on and choose Finish setup with sync enabled. This publishes only the displayed synced data after confirmation.

## Start a short Flexible session and trigger a block

5. Click the Focus Lock toolbar icon. In Custom minutes, enter `2`. In Intention, enter `Chrome Web Store review`.
6. Choose Flexible under Session type. Keep Block selected sites as the blocking mode. Confirm Social media is selected under What will be blocked.
7. Choose Start 2 min - Block selected sites.
8. After the session starts, open a new normal top-level tab and navigate to `https://x.com/`.
9. Confirm the blocking surface shows the intention, countdown, blocked-attempt count, and provenance text `Blocked by Social media: x.com`. Provenance identifies the exact rule source and matched domain. x.com is an unaffiliated example from the bundled Social media list. If the review environment cannot reach it or rewrites the URL, navigate to another domain shown in that list and substitute the final registrable host in the expected provenance text.
10. Click the Focus Lock toolbar icon and choose End session. Flexible ends immediately without a wait or typed phrase. Focus Lock removes the blocking surface. If the document was stopped during navigation, the tab reloads so the requested page can render.

## Inspect Statistics

11. In the popup header, choose the Statistics button. Confirm Your focus record opens and Attempts blocked today includes the navigation from step 8.
12. In Recent sessions on this machine, confirm the `Chrome Web Store review` intention appears with an ended early outcome and a manual source marker.

## Verify sync and deletion controls

13. Open Options from the Focus Lock popup, then choose Privacy and data in the product navigation.
14. Confirm the page distinguishes Synced data from Local only data and states that nothing is sent to the Focus Lock developer.
15. Turn off Sync Focus Lock data across Chrome devices. Wait for the status `Chrome Sync disabled.` Disabling sync stops later writes but intentionally keeps any existing remote copy until the separate deletion action.
16. Under Remote Sync data, choose Delete remote Sync data, then Confirm delete remote Sync data. Wait for `Remote Chrome Sync data deleted.` Local settings and statistics remain on this device.
17. Under Local event log, choose Export local event log. Chrome downloads a JSON file containing the local detailed event log.
18. Choose Delete local history, then Confirm delete local history. Wait for `Local history deleted.` This removes historical full URLs, focus intentions, and detailed session events from the local event log. Because sync is off, local aggregate statistics are removed too. It does not clear the current live-session runtime, which holds the focus intention and the address of every website tab open while the session runs. A session set to run until stopped holds that runtime until the person ends it. Ending the session clears the intention and starts a cleanup that sends one clear instruction to each of those tabs. Each instruction holds that tab's address while the cleanup runs, and the cleanup removes every one of them when it completes. A record of each tab that received an instruction, in or between sessions, keeps that tab's address until Focus Lock's data is deleted as a whole.

## Expected boundaries

- Full URLs, focus intentions, detailed events, and live sessions remain in `chrome.storage.local`.
- Settings, lists, site access credit, streaks, and aggregate session totals with domain-level blocked-attempt counts use `chrome.storage.sync` only after the setup confirmation in step 4.
- Focus Lock reads, writes, and deletes the disclosed Chrome Sync data through Chrome's extension APIs. The developer does not receive or retain a separate copy.
- No extension data is sent to a developer-controlled server.
- The extension does not load or execute remote code.
