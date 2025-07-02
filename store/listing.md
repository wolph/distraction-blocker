Focus Lock blocks distracting websites during deliberate focus sessions. Choose what gets blocked, decide how difficult early exit should be, and earn bounded pauses without losing the state of pages you already had open.

## Features

- Block selected site categories and custom rules, or allow only selected sites.
- Choose Flexible, Friction, or Hard lock before each session. Friction can require a wait and typed confirmation. Hard lock cannot end early.
- Stop fresh blocked navigations before page content renders. Already-open pages receive an in-place overlay and keep their form, scroll, and JavaScript state.
- Earn pause time at a configurable rate and cap. Pause and one-site unlock actions use a deliberation gate.
- Run manual, cycling, or scheduled sessions and inspect session and blocking records in Statistics.

## Privacy boundaries

Full URLs, focus intentions, detailed events, and live sessions remain in the local Chrome profile. Focus Lock sends nothing to a developer-controlled server. It has no advertising, sale of user data, behavioral profiling, or remote code.

If Chrome Sync is enabled after setup confirmation, it receives settings, block and allow lists, pause balance, streaks, and per-device daily and monthly session totals with domain-level blocked-attempt counts. Full URLs, intentions, detailed events, and live sessions never enter Chrome Sync through Focus Lock.

Privacy policy: https://wolph.github.io/distraction-blocker/privacy/

## Permissions

Focus Lock requests optional access to HTTP and HTTPS websites during onboarding. This access lets it read page addresses for local rule matching, stop fresh blocked navigations, add or remove its blocking interface, and mute or restore affected tabs. It does not inspect page text, form fields, passwords, or messages.

The extension also uses Chrome permissions for local and optional synced storage, session and schedule alarms, tab state, top-level navigation changes, extension-packaged audio, notifications, and dynamic registration of its packaged blocking script.

## Sync choice and data controls

Chrome Sync is a setup choice and can be disabled later in Settings > Privacy and data. The same page can export the local event log, delete local history, and, after sync is disabled, separately delete remote Focus Lock data from Chrome Sync.

## Limitations

- Chrome only. Blocking applies to top-level HTTP and HTTPS pages, not embedded widgets.
- Chrome internal pages and the Chrome Web Store cannot host the blocking script.
- Focus Lock cannot prevent a user from disabling the extension and does not block other browsers, apps, or devices.
- Chrome Sync is eventually consistent, so aggregate totals can briefly differ between devices.

Support and issue reports: https://github.com/WoLpH/distraction-blocker/issues

Source code: https://github.com/WoLpH/distraction-blocker
