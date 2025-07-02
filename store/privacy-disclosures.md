# Chrome Web Store privacy disclosures

## Submission checkboxes

Use these exact declarations for the submitted build.

### Data handled

- [x] Browsing activity: full HTTP and HTTPS URLs are handled locally for rule matching. Blocked navigation events can include a full URL in the local detailed event log.
- [x] Website content access: the extension can stop a fresh top-level navigation, add or remove its packaged blocking interface, and mute or restore a tab. It does not inspect page text, forms, passwords, messages, or other page content.
- [x] User-generated intentions: text entered in the Intention field is stored with local session state and detailed session events. The field can contain anything the user chooses to type.
- [x] Local storage: full URLs, intentions, detailed events, live sessions, setup state, and local working copies are stored in `chrome.storage.local` within the Chrome profile.
- [x] Chrome Sync: only settings, block and allow lists, pause balance, streaks, and per-device daily and monthly session totals with domain-level blocked-attempt counts use `chrome.storage.sync`, and only after setup is confirmed with sync enabled.

### Data use and transmission

- [x] No developer-controlled server: Focus Lock sends no extension data to an endpoint operated by the developer.
- [x] No sale: Focus Lock does not sell user data or use it for creditworthiness or lending decisions.
- [x] No advertising: Focus Lock does not use or transfer user data for advertising, ad personalization, or behavioral profiling.
- [x] No unrelated transfer: data is not transferred to third parties except the user-approved use of Google-operated Chrome Sync for the disclosed cross-device feature.
- [x] No remote code: all executable JavaScript, HTML, CSS, images, and audio behavior ship in the extension package. The extension does not download or execute remote code.

### Retention and user controls

- [x] Retention: the local detailed event log is capped at 50,000 records. Daily aggregate retention is configurable and defaults to 90 days. Expired daily aggregates roll into monthly aggregates. Settings remain until changed or deleted. When sync is enabled, the oldest monthly aggregates can be discarded if needed to fit Chrome Sync's storage quota. Chrome and Google can also apply their own storage rules.
- [x] Export: Settings > Privacy and data > Export local event log downloads the detailed local event log as JSON.
- [x] Local deletion: Settings > Privacy and data > Delete local history removes full URLs, intentions, and detailed session events. In local-only mode it also removes local aggregate statistics. It does not end a live session.
- [x] Sync disable: Settings > Privacy and data > Sync Focus Lock data across Chrome devices stops future Focus Lock sync writes after the switch is turned off. Existing remote copies are not silently deleted.
- [x] Separate synced deletion: after sync is off, Settings > Privacy and data > Delete remote Sync data removes Focus Lock's remote settings, lists, pause balance, streaks, and aggregate session totals and domain-level blocked-attempt counts while preserving local settings and statistics.

## Chrome Web Store data-type selections

Select the dashboard categories that cover the handled data above:

- [x] Web history, for full URLs and blocked navigation records.
- [x] Website content, because optional website access can change the top-level page by adding the blocking interface or stopping its load.
- [x] User activity or user-provided content, for focus intentions and detailed session and gate events.
- [ ] Personally identifiable information, health information, financial and payment information, authentication information, personal communications, and location are not requested or used as Focus Lock features.

Focus Lock does not ask users to enter sensitive information. A user can put arbitrary text in a focus intention, so that text receives the same local-only treatment regardless of its contents.

## Single purpose and Limited Use

Focus Lock's single purpose is to enforce user-configured website blocking during deliberate focus sessions and provide the session, pause, and history controls needed to operate that blocking.

Browsing activity is handled only when required to match the current top-level URL against the active rules, enforce the resulting decision, restore affected tabs, and show the user's own local or domain-level record. It is not used for a separate feature.

Focus Lock's use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Storage boundaries

| Data | Local Chrome profile | Chrome Sync after confirmation | Developer-controlled server |
| --- | --- | --- | --- |
| Full URLs | Yes | No | No |
| Focus intentions | Yes | No | No |
| Detailed events and gate outcomes | Yes | No | No |
| Live session, gates, and temporary unlocks | Yes | No | No |
| Settings and block or allow lists | Working copy | Yes | No |
| Pause balance and streaks | Working copy | Yes | No |
| Daily and monthly session totals and domain-level blocked-attempt counts | Working copy for this device | Yes | No |

Focus Lock does not receive or control Chrome Sync data. Chrome and Google handling is governed by the [Google Privacy Policy](https://policies.google.com/privacy) and applicable [Google Chrome Terms of Service](https://www.google.com/chrome/terms/).

Published privacy policy: https://wolph.github.io/distraction-blocker/privacy/
