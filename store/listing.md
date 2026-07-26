Focus Lock blocks distracting websites during deliberate focus sessions. Choose what gets blocked, decide how difficult early exit should be, and earn bounded site access credit without losing the state of pages you already had open.

## Features

- Block selected site categories and custom rules, or allow only selected sites.
- Set a session length, or run a session until you stop it. A timed session ends on its own. A session set to run until stopped ends when you end it from the popup. A schedule can start either kind, and a scheduled timed session runs to the end of its window.
- Choose Flexible, Friction, or Hard lock before a timed session. Friction can require a wait and typed confirmation. Hard lock cannot end early. A session set to run until stopped is always Flexible and runs no focus and break cycles, and the popup shows both settings as fixed while it is selected.
- Focus Lock checks top-level navigations and replaces blocked pages with its blocking surface. Already-open pages receive an in-place overlay and keep their form, scroll, and JavaScript state.
- Earn site access credit at a configurable rate and limit. Access to all sites and one-site unlock actions use a deliberation gate.
- Start a session yourself or on a schedule, run focus and break cycles in a timed one, and inspect session and blocking records in Statistics.

## Privacy boundaries

Full URLs, focus intentions, detailed events, and live sessions remain in the local Chrome profile. Focus Lock sends nothing to a developer-controlled server. It has no advertising, sale of user data, behavioral profiling, or remote code.

If Chrome Sync is enabled after setup confirmation, it receives settings, block and allow lists, site access credit, streaks, and per-device daily and monthly session totals with domain-level blocked-attempt counts. Full URLs, intentions, detailed events, and live sessions never enter Chrome Sync through Focus Lock.

Focus Lock reads, writes, and deletes the disclosed Chrome Sync data through Chrome's extension APIs. The developer does not receive or retain a separate copy.

Privacy policy: https://wolph.github.io/distraction-blocker/privacy/

## Permissions

Focus Lock requests optional access to HTTP and HTTPS websites during onboarding. This access lets it read page addresses for local rule matching, check top-level navigations, replace blocked pages with its blocking surface, and mute or restore affected tabs. It does not inspect page text, form fields, passwords, or messages.

The extension also uses Chrome permissions for local and optional synced storage, session and schedule alarms, tab state, site icons from Chrome's local favicon cache for the work tab picker, top-level navigation changes, extension-packaged audio, notifications, and dynamic registration of its packaged blocking script.

## Sync choice and data controls

Chrome Sync is a setup choice and can be disabled later in Settings > Privacy and data. The same page can export the local event log and separately delete remote Focus Lock data from Chrome Sync after sync is disabled.

Delete local history removes historical full URLs, focus intentions, and detailed session events from the local event log. In local-only mode, it also removes local aggregate statistics. It does not clear the current live-session runtime, which holds the focus intention and the address of every website tab open while the session runs. A session set to run until stopped holds that runtime until the person ends it. Ending the session clears the intention and starts a cleanup that sends one clear instruction to each of those tabs. Each instruction holds that tab's address while the cleanup runs, and the cleanup removes every one of them when it completes. A record of each tab that received an instruction, in or between sessions, keeps that tab's address until Focus Lock's data is deleted as a whole.

## Limitations

Blocking is enforced by the extension's service worker. If Chrome has not woken the worker when a page starts loading, that page can load before the block applies. Focus Lock does not use declarativeNetRequest rules. A page that loads that way is re-evaluated once the worker answers.

- Chrome only. Blocking applies to top-level HTTP and HTTPS pages, not embedded widgets.
- Chrome internal pages and the Chrome Web Store cannot host the blocking script.
- Focus Lock cannot prevent a user from disabling the extension and does not block other browsers, apps, or devices.
- Chrome Sync is eventually consistent, so aggregate totals can briefly differ between devices.

Support and issue reports: https://github.com/WoLpH/distraction-blocker/issues

Source code: https://github.com/WoLpH/distraction-blocker
