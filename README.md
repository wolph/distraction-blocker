# Focus Lock

Focus Lock is a Chrome extension for focus sessions that blocks distracting sites without redirecting them. It checks top-level navigations and replaces blocked pages with the Focus Lock blocking surface, overlays and mutes already-open blocked tabs without reloading them, handles single-page app URL changes, earns capped site access credit for temporary access behind a deliberation gate, and restores scheduled sessions and local session state after the Manifest V3 worker wakes again.

## Research foundation

The defaults are evidence-informed, not a treatment claim. A short deliberation gate is based on the [one sec field experiment in PNAS](https://www.pnas.org/doi/abs/10.1073/pnas.2213114120) and its [longitudinal CHI follow-up](https://dl.acm.org/doi/10.1145/3613904.3642370). Scheduled breaks are supported by the [Biwer et al. comparison of systematic and self-regulated breaks](https://bpspsychub.onlinelibrary.wiley.com/doi/abs/10.1111/bjep.12593), while the [Albulescu et al. meta-analysis](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0272460) supports short breaks for vigor and fatigue more clearly than for performance. Visible time follows the adult ADHD time-perception evidence summarized in this [peer-reviewed review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9962130/). Precommitted strictness follows the drift documented by [Not Now, Ask Later](https://dl.acm.org/doi/fullHtml/10.1145/3411764.3445695). No published trial establishes Focus Lock itself, a 25/5 optimum for adults with ADHD, a 52/17 rule, a 90-minute biological work cycle, a 23-minute refocus time, or a benefit from completion sounds. Those claims are deliberately absent from the UI.

## Install from source

You need Node.js 22, npm, and a Chromium-based Chrome installation.

```bash
npm ci
npm run build
```

Then load the built extension:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked and select this repository's `dist` directory.
4. Open the Focus Lock details page and turn on Allow in Incognito if you want blocking in incognito windows.
5. Pin Focus Lock from Chrome's Extensions menu if you want the session state and countdown visible on the toolbar.

The manifest contains a fixed public key, so unpacked builds keep the same extension ID. That stable ID is required for Chrome Sync to associate installs consistently. Sync also requires Chrome profiles signed into the same Google account with extension sync enabled. Allow in Incognito is a per-profile Chrome permission and must be enabled manually.

The corresponding `key.pem` must remain untracked. A maintainer must back it up outside Git in a password manager or synced secret store. The repository can verify the ignore rule and matching public key, but it cannot verify the external backup.

After another build, use the Reload button on `chrome://extensions` to load the new files.

## Usage

Open the popup, choose a duration, enter the task you intend to finish, select categories, and start focusing. The default presets are 15, 25, and 50 minutes. The 50-minute preset is labeled as a preference rather than a scientific optimum.

- Blacklist mode blocks enabled categories and custom host or URL-regex rules. Whitelist mode blocks the web except for the listed rules.
- Friction sessions can end early only after a worker-enforced wait and an exact typed sentence. Hard sessions cannot end early, and settings or list changes that would weaken the active lock are rejected.
- Focus time earns site access credit continuously. The default rate is 5 minutes per 30 focused minutes, capped at 30 minutes. A default spend buys either 5 minutes of access to all sites or a 5-minute unlock for the current registrable site. You can step away from the screen at any time without spending credit.
- Temporary access actions use the configured deliberation gate, with a 10-second default and an immediate Back to work choice. Access to all sites can be ended early.
- Cycling alternates focus with short and long breaks. Schedules can start blacklist or whitelist sessions on selected weekdays and local time windows.
- Options contains category switches, per-site category exclusions, custom domain and URL-regex rules, whitelist rules, schedule entries, site access credit settings, sounds, badge behaviour, and data export.

Fresh blocked navigations show an opaque locked document. A page that was already open receives an overlay and is muted in place. When blocking ends, the existing page retains its form, scroll, and JavaScript state. A navigation that was stopped reloads so the requested page can render.

## Returning to work

The lockscreen shows your next step, the time until the next break or the session end, and one Back to work button. It activates the chosen tab and its window without navigating away from either page. Long tasks wrap, and the overlay scrolls independently of the blocked page.

Open Need a break or site access? for credit and temporary access options. Each action shows its own cost and the time needed to afford it. When the credit limit or the remaining focus time makes a spend unavailable, the screen explains why instead of counting down to a button that stays disabled.

Choose a work tab directly on the lockscreen. The chooser uses almost the whole window and shows recently active tabs first. Each row includes its title, domain, cached favicon and a consistent colour for that domain. Search by title or domain to narrow the list, then select a tab to return to it. Only visible rows and a small buffer are rendered, keeping the list small even with thousands of tabs. Arrow Down moves from search into the results. Home and End reach the first and last result. Escape closes the chooser. Change work tab opens the list again.

Back to work shows the destination title and domain on the button. Long titles are shortened visually, with the full destination available to screen readers and on hover. Favicons come from Chrome's local cache. Reading the list and icons does not activate sleeping tabs. A closed or newly blocked work tab cannot be used as a return destination. A work tab never bypasses your blocklist or whitelist.

The work-tab reference stays in worker-only `chrome.storage.session`. It survives a service-worker restart but is cleared when Chrome restarts or the extension reloads. Choose the tab again after a restart. The saved focus session and site access credit use their existing storage and continue independently.

## Screenshots

The screenshots use an isolated Chrome profile with demonstration data.

![Choose a work tab directly on the lockscreen](https://raw.githubusercontent.com/WoLpH/distraction-blocker/master/docs/images/focus-lock/work-tab-picker.png)

| Active popup | Existing-page overlay | Deliberation gate |
| --- | --- | --- |
| ![Active focus popup](https://raw.githubusercontent.com/WoLpH/distraction-blocker/master/docs/images/focus-lock/popup-active.png) | ![Blocked existing page overlay](https://raw.githubusercontent.com/WoLpH/distraction-blocker/master/docs/images/focus-lock/overlay.png) | ![Deliberation gate](https://raw.githubusercontent.com/WoLpH/distraction-blocker/master/docs/images/focus-lock/gate.png) |
| Options | Stats | |
| ![Options page](https://raw.githubusercontent.com/WoLpH/distraction-blocker/master/docs/images/focus-lock/options.png) | ![Stats page](https://raw.githubusercontent.com/WoLpH/distraction-blocker/master/docs/images/focus-lock/stats.png) | |

## Stats and storage

The stats page reports focus time, blocked attempts, resisted gates, site access credit spending, recent sessions, hourly and daily activity, streaks, and freeze tokens. The options page can export the detailed local event log as JSON.

Full URLs, focus intentions, detailed events, and live sessions remain in the local Chrome profile. Chrome Sync receives settings, lists, site access credit, streak state, and per-device daily and monthly session totals with domain-level blocked-attempt counts only after setup is confirmed with sync enabled. An active session therefore resumes in the same Chrome profile, but it does not move live to another machine. Aggregate sync is eventually consistent and can briefly show different totals across machines.

Focus Lock reads, writes, and deletes the disclosed Chrome Sync data through Chrome's extension APIs. The developer does not receive or retain a separate copy. Chrome and Google handle Chrome Sync under their own terms.

Focus Lock sends no extension data to a developer-controlled server. Settings > Privacy and data can export the local event log, disable sync, and separately delete remote Focus Lock data from Chrome Sync. Delete local history removes historical full URLs, focus intentions, and detailed session events from the local event log. In local-only mode, it also removes local aggregate statistics. It does not clear the current live-session runtime, which holds the focus intention and the address of every website tab open while the session runs. A session set to run until stopped holds that runtime until the person ends it. Ending the session clears the intention. It leaves one clear instruction for each of those tabs, each holding that tab's address, and the next session replaces them.

## Privacy and support

- Privacy policy: https://wolph.github.io/distraction-blocker/privacy/
- Support and issue reports: https://github.com/WoLpH/distraction-blocker/issues

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite development mode |
| `npm run build` | Build the unpacked extension into `dist` |
| `npm run typecheck` | Run strict TypeScript checks |
| `npm run lint` | Check formatting and lint rules with Biome |
| `npm run format` | Apply Biome formatting fixes |
| `npm test` | Run the Vitest unit and component suite |
| `npm run e2e` | Build and run Playwright against an isolated Chromium profile |
| `npm run check` | Run Biome, TypeScript, Vitest, and a production build |

The end-to-end suite uses local test pages and an isolated browser profile. It does not need your normal Chrome profile.

Before adding tests, read [docs/testing-rules.md](docs/testing-rules.md). It is six rules with the evidence that earned them, and the first one is the one that catches everybody.

Before preparing a Chrome Web Store submission, read [docs/release-candidate-gate.md](docs/release-candidate-gate.md). It is ten ordered steps with the symptom each failure presents, because most of them fail in more than one way and several look like product defects while being the opposite.

## Known limitations and non-goals

- The user can disable the extension at `chrome://extensions`. No
  extension can prevent that without enterprise policy. The design
  accepts it: research says the enemy is uninstall drift, and the
  mitigation is the tool staying pleasant enough to keep (documented
  tip for the determined: a local `ExtensionInstallForcelist` policy,
  out of scope).
- Chrome only, top-level frames only, no embedded-widget blocking.
- `chrome://` pages and the Web Store cannot host content scripts.
- Sync cross-machine is eventually consistent, bank drift accepted.
- Does not block other apps, other browsers, or the phone. Not a
  parental control, trivially bypassable by a motivated admin user.
