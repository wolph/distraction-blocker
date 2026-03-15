# Chrome Web Store privacy disclosures

## Submission checkboxes

Use these exact declarations for the submitted build.

### Data handled

- [x] Browsing activity: full HTTP and HTTPS URLs are handled locally for rule matching. Blocked navigation events can include a full URL in the local detailed event log.
- [ ] Website content: top-level URLs are declared under Web history, not Website content. The extension adds its packaged blocking interface but does not inspect or collect page text, images, form fields, passwords, messages, or other site-provided content.
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
- [x] Local deletion: Settings > Privacy and data > Delete local history removes historical full URLs, focus intentions, and detailed session events from the local event log. In local-only mode, it also removes local aggregate statistics. It does not clear the current live-session runtime, including its URL and intention state, which remains until that live state ends.
- [x] Sync disable: Settings > Privacy and data > Sync Focus Lock data across Chrome devices stops future Focus Lock sync writes after the switch is turned off. Existing remote copies are not silently deleted.
- [x] Separate synced deletion: after sync is off, Settings > Privacy and data > Delete remote Sync data removes Focus Lock's remote settings, lists, pause balance, streaks, and aggregate session totals and domain-level blocked-attempt counts while preserving local settings and statistics.

## Chrome Web Store data-type selections

Select the dashboard categories that cover the handled data above:

- [x] Web history, for full URLs and blocked navigation records.
- [x] User activity, for detailed session and gate events and the user's blocking interactions.
- [x] User-provided content, for text entered in the focus intention field.
- [ ] Website content, because Focus Lock injects its packaged blocking interface without reading or collecting text, images, forms, messages, or other resources supplied by the website.
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

The local runtime keys `runtime`, `runtimeSchema`, `runtimeMigration`, `events`, and `dataClearJournal` are local only. They hold the live session and its schema marker, any pending migration record, the detailed event log, and any deletion still in progress. A deletion in progress carries a copy of the live session, including the page addresses it is enforcing against, for as long as that deletion takes. Focus Lock never writes any of these keys to Chrome Sync.

Focus Lock reads, writes, and deletes the disclosed Chrome Sync data through Chrome's extension APIs. The developer does not receive or retain a separate copy. Chrome and Google handling is governed by the [Google Privacy Policy](https://policies.google.com/privacy) and applicable [Google Chrome Terms of Service](https://www.google.com/chrome/terms/).

## Public URL verification

Before the first deployment, this check is expected to fail because GitHub Pages has not published
the privacy policy:

```console
curl --fail --silent --show-error https://wolph.github.io/distraction-blocker/privacy/ > /dev/null
```

After the Pages workflow deploys successfully, the command should exit with status 0.

Privacy policy URL: https://wolph.github.io/distraction-blocker/privacy/
