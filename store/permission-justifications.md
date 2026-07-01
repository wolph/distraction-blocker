# Chrome Web Store permission justifications

Manifest source: `manifest.config.ts`. Each requested permission maps to one or more shipped user-facing behaviors below.

| Manifest permission | Shipped behavior | Why the permission is needed | Status |
| --- | --- | --- | --- |
| `storage` | Saves setup, settings, lists, site access credit, streak state, event history, active runtime state, and aggregate statistics. Uses Chrome Sync only after user confirmation. | Focus Lock must resume sessions after the Manifest V3 worker sleeps and must preserve the user's selected policy. Chrome storage supplies local persistence and the optional cross-device feature. | Used |
| `alarms` | Advances focus, pause, and cycle phases, wakes for minute ticks, and evaluates schedules. | A Manifest V3 service worker is not continuously alive. Chrome alarms wake it for durable time-based transitions. | Used |
| `tabs` | Reads the active tab URL for a one-site unlock, enumerates open web tabs, sends frozen enforcement commands and epoch resets to the packaged blocking script, mutes and restores affected tabs, reloads a navigation that Focus Lock stopped, and opens extension pages. | Blocking rules and restoration operate on the user's actual top-level tabs. URL access is used only for the disclosed blocking behavior. | Used |
| `webNavigation` | Observes committed top-level navigations and single-page app history changes. Looks up the current top-level document identity before applying a decision. | Focus Lock must apply the same rule after a normal navigation or an in-page URL transition and avoid acting on a stale document. | Used |
| `offscreen` | Creates the packaged offscreen audio document when a configured session or break sound needs to play. | Manifest V3 service workers cannot play audio directly. The offscreen document is used only for extension-packaged audio playback. | Used |
| `notifications` | Shows the optional session-complete notification. | Chrome notifications provide the configured completion notice after the popup is closed. Users can turn this behavior off in Settings. | Used |
| `scripting` | Registers and unregisters the packaged document-start blocking script after website access changes. It can also inject that packaged script into an existing eligible tab during reconciliation. | Website access is optional and granted during onboarding, so the blocking script must be registered dynamically after consent and removed if access is revoked. | Used |
| `http://*/*` and `https://*/*` in `optional_host_permissions` | Reads top-level page URLs for local rule matching, stops fresh blocked loads, adds or removes the blocking interface, and mutes or restores an affected tab. | User-selected categories, custom domain or URL-regex rules, and allow-only mode can cover any HTTP or HTTPS website. A narrower static host list would make those user-facing rules incomplete. Access is requested during onboarding rather than at installation. | Used |

## Permission minimization result

Unused manifest permissions: none in the submitted build. Every permission above has a direct source reference and a shipped user-facing behavior.

If a mapped behavior is removed, mark its permission unused and remove it from `manifest.config.ts` before the next submission. In particular, remove `notifications` if the completion notification is removed, remove `offscreen` if packaged audio is removed, and remove both `scripting` and the optional host patterns if website blocking is removed.

## Source references

- `manifest.config.ts`: complete permission declaration and optional host patterns.
- `src/background/main.ts`: alarms, notification and audio ports, and tab listener registration.
- `src/background/tabs.ts`: tab enumeration, URL decisions, muting, reload, content messages, navigation listeners, and existing-tab injection.
- `src/background/content-registration.ts`: dynamic registration after optional website access is granted.
- `src/background/audio.ts`: packaged offscreen audio document and notifications.
- `src/background/policy-storage.ts`: local and optional synced persistence.
- `src/onboarding/App.tsx`: user-triggered optional website access request and final storage-mode confirmation.
