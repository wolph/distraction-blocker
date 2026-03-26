# Focus Lock QA checklist

This document is a sign-off, so it is organised by who can be responsible for each claim rather
than by feature. That is the change: it used to mix machine facts, human judgements and outstanding
tasks in one list of prose paragraphs, and the machine facts rotted silently while the reader had no
way to tell which claims were still true.

Three sections, three kinds of responsibility.

1. **Machine-verified inventory.** Generated. Nobody signs it, and a stale number fails a test.
2. **Signed judgements.** What a person looked at and concluded. Small, and re-signed when the
   surface it covers changes.
3. **Manual gate.** What no automation can do. Tasks rather than measurements, so it cannot rot.

Anything not in one of the three is not a sign-off claim. Evidence paths appear only where the
evidence is durable, and where it is not, this document says so rather than pointing at a location
that no longer holds anything.

## Machine-verified inventory

<!-- BEGIN GENERATED: scripts/qa-checklist.mjs -->

Derived by `node scripts/qa-checklist.mjs`, guarded by
`tests/unit/docs/qa-checklist-contract.test.ts`. Nobody signs this section. Every number here
is asked of the runner, or of the glob the runner is configured with, so a stale one fails a
test rather than misleading a reader.

Unit suite: **162 files** matching `tests/unit/**/*.test.{ts,tsx}`, the pattern
`vitest.config.ts` declares. The number of individual test cases is deliberately not recorded:
deriving it means collecting every file, which is the expensive half of a run, and a number
that needs a run to verify is exactly the kind that went stale here four times.

End-to-end suite: **82 scenarios in 15 spec files**, as Playwright itself
lists them. Asking the runner rather than counting `test(` in the sources is not pedantry: a
grep undercounts `test.skip`, which is listed and reported, and misses a spec file added
since the grep was written. Both mistakes were present when this section was first drafted.

### blocked-navigation-load.spec.ts (1)

- blocking still works after forty blocked navigations

### blocking.spec.ts (5)

- SPA history navigation is blocked without a reload
- a blocked media tab is muted
- a stopped tab reloads after the session ends
- existing tab overlays, mutes, and resumes without reload
- fresh navigation to a blocked site is stopped and overlaid

### closure-reasons.spec.ts (4)

- a migrated session with no valid v2 form ends as an invalid active state
- a session whose documents cannot be reached ends as a tab enforcement failure
- a session whose phase alarm cannot be held ends as an alarm failure
- a start whose registration cannot be audited fails as a registration failure

### gates.spec.ts (11)

- Flexible session ending immediately removes an active block
- abandoning a gate records a resisted temptation
- friction cancellation with typing requires the configured phrase after its delay
- friction cancellation without typing uses the configured delay
- hard sessions reject cancellation gates
- hard sessions reject weakening list changes
- overlay unlock isolates another site and reblocks after expiry
- pause gate rejects an early confirmation and unblocks after its delay
- pause gate supports back to work, taking a pause, and resuming now
- paused UI leaves when the session wall clock ends
- zero delay removes the wait but still honors the typing setting

### indefinite-recovery.spec.ts (7)

- a browser relaunch after a timed end closes the session at its own end instant
- a browser relaunch after a timed end finishes its cleanup and allows the next session
- a browser relaunch during indefinite focus keeps the session and counts the closed time
- a scheduled indefinite session keeps its occurrence across a worker restart
- a worker restart during an indefinite pause keeps the pause and still resumes
- a worker restart during indefinite focus recovers the same session
- a worker restart racing a start settles on exactly one outcome

### indefinite-visual.spec.ts (1)

- captures deterministic indefinite session visual evidence

### indefinite.spec.ts (12)

- a 50 minute cycling session labels its phase and its session separately
- a pause that expires resumes indefinite focus with no end in sight
- a scheduled until-stopped window starts once and never relocks inside itself
- a stopped fresh navigation carries the indefinite and stopped-page copy
- an indefinite pause freezes focus time and still ends from the popup
- end authority follows the session type a timed session was started with
- manual end reasons separate a timed cancel from an indefinite completion
- manual until-stopped start forces the flexible plan and reports it everywhere
- popup End completes the indefinite session manually and silently
- settings reports the indefinite session and discloses that the popup owns it
- stats reports the indefinite plan and both manual outcomes
- the indefinite blocked page hands every ending to the popup

### onboarding-visual.spec.ts (1)

- production onboarding states fit every viewport and theme

### onboarding.spec.ts (6)

- denied access can be retried, completed locally, and block a real page
- fresh install has no host access and popup routes to unfinished setup
- permission revocation ends a session and rejects another session start
- quota-backed first sync checkpoint survives worker and browser restart, then retries
- setup completion waits for delayed initial load and step transitions
- sync completion and dynamic registration survive a browser restart

### package-install.spec.ts (2)

- the packaged artifact installs, onboards, blocks, and survives a browser restart
- the release ZIP extracts under archive safety rules and is the only loaded build

### qa-flows.spec.ts (8)

- Options exposes destination saving, category states, and scoped privacy confirmations
- Task 5 Stats responsive evidence matrix is reproducible
- Task 7 production evidence matrix is reproducible
- Task 7 save bar stays bottom-anchored and unobscured after internal-scroll transition
- completion clears browser effects and reaches sound and notification APIs
- hard-session Options rejects weakening and saves a stronger rule
- popup daily states keep help and long rules contained at native width
- theme cycle persists across extension pages and live overlay hosts without reloads

### restart.spec.ts (1)

- persistent profile restores a blocked muted tab and active countdown after relaunch

### smoke.spec.ts (9)

- Stats content stays inside responsive viewports
- Stats navigation round-trips through an Options section
- blockable test site loads without a session
- extension loads and the worker answers getSnapshot
- options current navigation meets light text contrast
- options page fits a mobile viewport
- options primary button meets dark text contrast
- options rejection and save actions stay together at the viewport edge
- popup page renders

### store-screenshots.spec.ts (9)

- captures five truthful release states with category membership in the popup and permission copy in onboarding
- default screenshot publication compares complete bytes without changing canonical files
- explicit update publication replaces a safe canonical fixture after staging
- hostile Pago Pago host timezone reproduces every Amsterdam canonical byte
- screenshot integrity rejects a transparent interior pixel
- screenshot update mode rejects every value except the documented 1
- store screenshot inventory is exact, intact, opaque, and 1280 by 800
- update publication restores the complete canonical set after a later replacement fails
- update staging leaves the canonical set untouched after a later write fails

### system.spec.ts (5)

- an active schedule window starts a scheduled focus session
- badge shows a countdown during focus and clears on completion
- privacy data deletion keeps local and remote scopes separate
- projected first-Sync publication rejects total quota overflow and preserves local policy
- sync and local storage keep their documented split and quota

<!-- END GENERATED -->

## Signed judgements

Each entry names what a person looked at, what they concluded, and the surface it covers. When that
surface changes, the entry is re-signed or struck. An entry with no signature is not a claim.

Nothing in this section may restate a number, a duration, a digest or a count. Those belong above,
where they are derived. This section holds only what a machine could not have decided.

### Visual inspection of the onboarding surfaces

Signed against onboarding through commit `fa6a34d`. Representative full-page and focused captures
were inspected at 375, 768 and 1280 px, in Auto with light media, Auto with dark media, explicit
Light with dark media, and explicit Dark with light media. Headings, expanded category lists,
warning and recovery messages, button rows, the Sync switch, the disabled pending-completion
action, focus outlines and viewport edges were all readable and contained. The longest bundled
domain, `store.steampowered.com`, wraps rather than overflowing.

Durable evidence: `docs/qa-artifacts/onboarding-task6/`, whose archives and manifests are tracked
and digest-pinned, with a portable verifier at
`docs/qa-artifacts/onboarding-task6/verify.mjs`. Run it to confirm the archives still hash to what
the manifests record.

### Hover and keyboard focus coverage

Signed against the popup, Options, Stats, the gates and both overlay forms. Hover and keyboard focus
were exercised on the popup cog and theme control, both settings menus, all four category bulk
actions, typed and untyped gate confirmation, the overlay actions and the Stats chart controls, in
all four theme and media cases.

Evidence: `artifacts/daily-product-surfaces-task7/`, inventoried by `evidence-manifest.json`, which
records a SHA-256 for every file including its own generator. That directory is ignored by git
except for the generator, which is tracked deliberately because the manifest pins its bytes.

### Native Chrome permission prompt

Signed against the real browser-owned sheet, not a mock. Chrome-for-Testing 151.0.7922.34 showed the
prompt only after `Enable website blocking` was clicked, removed it on `Deny`, showed it again on
`Retry` and removed it on `Allow`. The onboarding explanation reproduces Chrome's capability line
exactly, `Read and change all your data on all websites`, and omits no material capability.

Durable evidence: `docs/qa-artifacts/onboarding-task6/real-prompt/` with
`manifests/real-prompt-manifest.json`, both tracked and digest-pinned.

### Diagnostics were clean on the runs that produced the evidence above

Signed against the production and development evidence runs. Console errors, page errors, worker
errors, request failures and blocked requests were all zero. Shutdown-only worker messages are
classified under an exact allowlist: any count including zero is valid only while every message
equals `focus-lock background error Error: The browser is shutting down.`, and changed or
unclassified text is an error rather than a warning.

This entry covers the runs whose reports are pinned in the evidence above. It does not cover any
later run, which is the point of signing it against named evidence.

## Manual gate

Tasks no automation in this repository can perform. They describe an action rather than a
measurement, which is why they are the only part of this document that could never go stale.

- [ ] Confirm Chrome Sync across two signed-in profiles.
- [ ] Hear session-complete, break-start, break-end, and schedule-start sounds through real speakers.
- [ ] Confirm operating-system-visible notifications outside the isolated browser environment.
- [ ] Confirm blocking in an incognito tab after enabling the per-extension permission in a safe isolated profile.
- [ ] Confirm the untracked `key.pem` has an external backup.
- [ ] Confirm the pinned-toolbar badge appearance in a real browser window, and preserve the capture
      somewhere tracked. The previous capture is gone, as recorded under Evidence that was not
      preserved. The drawing itself is machine-verified, because `npm run build` regenerates the four
      icons from `padlock.svg` deterministically and the check gate fails if they change, but no
      automated check can confirm how the badge looks pinned to a real toolbar.

## Evidence that was not preserved

Kept as a record rather than deleted. A line that once claimed evidence and is now silently removed
is worse than one that admits the evidence is gone, because the reader cannot tell the difference
between a claim that was retired and a claim that was quietly dropped.

**The `.playwright-mcp/qa-final/` directory is gone.** It held the pre-redesign exact run: a report,
a shutdown-message list, the contact sheets, the pinned-toolbar capture from commit `0ed0c27`, and
the prepared profile from `9f453d6`. The directory was ignored by git and has since been removed.
The document already described it as retained for history only and not as completion evidence for
any current surface, so nothing signed above depended on it. Nothing replaces it. The one claim that
rested on it, the pinned-toolbar appearance, has moved to the manual gate.

**The eight `test-results/` paths are gone.** They named Playwright's per-test output directories
for the Task 5 onboarding and restart runs. That directory is git-ignored scratch which each run
overwrites, and it now holds a different run's directories entirely. Those paths named a location
rather than preserved evidence: Playwright retains traces only on failure, so a passing run leaves
nothing worth pinning, which the document previously admitted two lines after listing them. The
runs themselves are reproducible from the commands in the inventory above, which is the durable
form of that claim.

**What this cost, stated once.** Both classes of loss share a cause: the path was pinned without a
digest, and nothing ever checked that the path still resolved. Every piece of evidence that survived
was either tracked in git or digest-pinned, and every piece that was pinned by path alone is gone.
That is the rule this section exists to record.
