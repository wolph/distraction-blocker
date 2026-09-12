# Release-candidate gate

Run this before submitting Focus Lock to the Chrome Web Store. Follow it in order. Every step names
the command, what a pass proves, and what a failure means, because most of these fail in more than
one way and the difference decides what you do next.

Several of the steps report by what they produced rather than by their exit code, and the difference
matters more here than anywhere else in the repository: a green exit on a stale artifact is the
failure this gate exists to prevent.

**This gate cannot be completed by an agent alone.** Step 5 ends in a human looking at five
images, and no digest substitutes for it: the provenance check proves the screenshots came from
this build, which is a different claim from their showing the product well. An agent can run every
command here and report every artifact, and the run is still incomplete until a person has looked.
Step 8 records that item as outstanding rather than passed, and step 9 lists the other two things
this gate does not certify.

**Read these six constraints first. Three of the steps are destructive of other people's work if
you ignore them.**

- **Steps 4 through 7 need a quiet machine.** They launch real browsers. The visual capture in
  step 7 takes about 25 minutes on an idle machine and does not finish on a busy one. Do not start
  them while anyone is running a capture, a build, or a full suite.
- **Only step 2 is safe on a busy machine.** Steps 1, 3 and 7 all end in a build, and a build
  rewrites `dist/`, which every browser step reads for as long as it runs. Running one of them
  while someone else has browsers open corrupts their run rather than yours, and the symptom is not
  an obvious failure: a rebuild landing under a running suite has made a durable event log read
  back empty, which was very nearly filed as a product defect before the artifact hash showed the
  bundle had moved. Steps 1 through 3 spawn no browser, which is a different claim from being safe.
- **Bracket every browser step with the artifact hash.** Before and after each of steps 5, 6 and 7:

  ```bash
  shasum -a 256 dist/assets/index.ts-*.js
  ```

  A hash that moved means somebody built underneath you and the run certifies nothing. Re-run it
  rather than reading it. Failures have been observed that were absent before a run and passed on
  re-run against the identical build, and that is only knowable with this bracket.
- **Clear `test-results/` before you start, and leave `artifacts/` alone.** The evidence specs
  verify a directory's contents against a manifest, and leftover files from an earlier or partial
  run fail that parity check with a message that names the directory rather than the cause.
  `Task 5 Stats responsive evidence matrix` fails this way inside a full-file run and passes alone.
  The directory at fault is Playwright's own `test-results/`, because with no evidence environment
  variable set these specs write to `testInfo.outputPath(...)` underneath it, and a filtered run
  leaves output the next run reads. `rm -rf test-results` is safe: it is gitignored and entirely
  regenerated. `artifacts/` is a different thing and this gate never writes it, since no step sets
  `STATS_EVIDENCE_DIR`, `INDEFINITE_EVIDENCE_DIR`, `TASK4_EVIDENCE_DIR` or `TASK7_EVIDENCE_DIR`. It
  holds evidence from earlier captures and at least one tracked file, so deleting it destroys work
  this gate did not produce.
- **Do not start a run near local midnight.** Several scenarios open a wall-clock schedule window
  on the current local day, which cannot be built across the boundary, so they skip rather than
  fail. That is correct behaviour and it is also a gate that quietly certifies less than a full one:
  the only trace is a higher skip count that nobody reads. A run finishing at 23:54 lost two
  scenarios this way, so **start at least thirty minutes clear of local midnight**, which is the
  twenty minute guard the scenarios use plus the ten a full step 7 takes. If you cannot, record in
  step 8 which scenarios the guard skipped and why, so the evidence says what the run did not cover.
- **Nothing here may run against a dirty or moving tree.** Step 0 establishes that, and step 5's
  whole purpose is defeated if a commit lands mid-gate.

## What it costs

Measured on one full run on an idle machine, so budget from these rather than from feel. Steps 0
through 4 together are about four minutes and safe to interleave with reading. The two long ones
are where the plan goes wrong if you start them without the time.

| Step | Wall clock | What it produced |
| --- | --- | --- |
| 0 | seconds | one commit hash |
| 1 | about 2 minutes | Biome over 423 files, TypeScript, Vitest 162 files and 4286 cases in 66s, one build |
| 2 | seconds | one line of output |
| 3 | under a minute | one archive, two validator passes |
| 4 | about a minute | the archive inspection, most of it the per-entry byte comparison |
| 5 | seconds when the provenance already matches, about 25 minutes when it does not | five PNGs, and a human look that is not on this clock |
| 6 | under a minute | 2 scenarios |
| 7 | about 10 minutes | 81 scenarios, 2 of them skipped by design |

Step 5 is the one that ruins an estimate. If `screenshots-provenance.json` already records the
digest of the `dist/` in front of you, there is nothing to recapture and the step is seconds. If it
does not, you are recapturing, and that is the 25 minute browser step plus the human look after it.
Check the provenance before you plan the afternoon.

## Step 0. Establish the tree you are gating

```bash
git status --short
git log --oneline -1
```

**Proves:** you know which commit this gate certifies, and no uncommitted work will be silently
included in an artifact.

**A failure means:** if anything the gate certifies is uncommitted, stop. Either the work is
unfinished or somebody else holds a file. Gating a dirty tree produces an artifact that matches no
commit, and step 8 records a hash nobody can reproduce.

Read that as the paths this gate signs, which are `src/`, `tests/`, `store/`, `docs/` and the build
configuration, rather than as an empty `git status`. On a branch several people share, `git status`
is rarely empty and untracked evidence directories are expected to be there. A blanket rule nobody
can satisfy gets skipped rather than followed, and then nobody checks the paths that do matter.

Write the commit hash down now. Every later step is reported against it.

## Step 1. Tracked-code verification

```bash
NO_COLOR=1 npm run check
```

That is `biome check . && tsc --noEmit && vitest run && npm run build:store`, in that order, stopping at
the first failure. The store build omits the manifest key that ordinary unpacked builds use for a
stable local extension ID. `npm run store:package` uses that same build mode, and the package
validator rejects any manifest key.

**Proves:** formatting and lint, types, the whole unit suite, deterministic icon generation, and a
production build. It cannot run a Playwright spec: `vitest.config.ts` includes only
`tests/unit/**/*.test.{ts,tsx}`.

**A failure means**, by stage:

- **Biome.** Formatting or lint. A formatting failure can appear in a file the last commit did not
  touch, because unexporting a symbol shortens a signature below the wrap width. Run
  `npx biome check .` over the whole tree rather than over your own changes.
- **TypeScript.** Read the file path before assuming it is yours. On a shared branch the failing
  file is often somebody else's in-flight test.
- **Vitest.** If the count of failures is large and the files are unrelated to each other, look for
  one shared fixture or one contract change rather than for many small breaks. If the only failure
  is `tests/unit/docs/qa-checklist-contract.test.ts`, the inventory is stale rather than the code:
  run `npm run qa:checklist`, commit the regenerated block, and start again. That contract is in
  the Vitest glob, so this step already enforces what step 2 checks, and it fails here first.
- **Build.** A real outage. The chunking warning about a module both statically and dynamically
  imported is not a failure and does not block.

## Step 2. Derived-inventory check

```bash
npm run qa:validate
```

**Proves:** `docs/qa-checklist.md`'s machine-verified inventory still matches what the suites
actually contain.

**A failure means:** the suites moved and the checklist did not. Run `npm run qa:checklist` to
regenerate, then commit that change before continuing, because step 8 signs this document.

Run this before the gate rather than during it. A stale inventory is a commit rather than a rerun,
and step 1 fails on it anyway through the contract test, so discovering it here means you have
already paid for a full `npm run check`.

Neither the regeneration nor the check needs a build. `npm run qa:checklist` asks Vitest's
configured glob for the unit files and asks `playwright test --list` for the end-to-end scenarios,
and listing collects the spec sources without launching a browser or reading `dist/`, which is
verifiable by moving `dist/` aside and listing anyway. What it does depend on is every spec file
being importable, so a spec with a collection error fails this step and the contract test together.
The practical consequence is that the inventory tracks spec sources, not the build, so it needs
regenerating after the last spec change and not after a rebuild or a capture.

## Step 3. Package, then immediately validate

```bash
npm run store:package
npm run store:validate
npm run pages:validate
```

**Run these three together and in this order, with no other command between them.** The archive is
built from `dist/`, and `dist/` is rewritten by anyone running a build. An archive validated ten
minutes after it was packaged may be a bundle behind, and the failure looks like a validator bug
rather than a stale artifact. The digest has been observed to move three times inside one working
session.

**Proves:** the archive exists, its recorded digest matches the file, its inputs satisfy the store
validator, and the Pages artifact builds and passes `html-validate`.

**A failure means:**

- **`store:validate` fails right after `store:package` succeeded.** Something rebuilt `dist/`
  between them. Re-run `store:package` and validate again. This is a stale artifact, not a finding.
  Only treat it as a finding if it reproduces on a quiet tree.
- **`pages:validate` fails.** The privacy page is malformed or the copy contract broke. This blocks
  submission, because the listing points at that page.

## Step 4. Inspect what the archive actually contains

Exit codes are not evidence. Check the artifact.

```bash
node -e "const p=require('./release/package-manifest.json'); console.log(p.zipPath,p.version,p.sha256)"
shasum -a 256 release/focus-lock-*.zip
unzip -l release/focus-lock-*.zip
rg -n "fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon" src dist
```

**Proves, when you read the output rather than the exit code:** the printed digest equals the digest
of the file on disk. `manifest.json` is at the archive root. No source maps, secrets or test files
are present, and no unreviewed network transport has appeared in the product code. The transport
search has exactly one expected family of hits: the favicon service in
`src/background/work-tab-icons.ts` and its bundled copy in the worker, which fetch the extension's
own `/_favicon/` URL so Chrome answers from its local favicon cache. The validator accepts only that
shape, listed under `extensionOriginFetch` in `store/submission-manifest.json`, and refuses every
other transport identifier.

Also confirm by inspection, because the validator does not: every entry in the archive has a
counterpart under `dist/` and is byte-identical, every declared entry point in the manifest resolves
inside the archive, and every local script and stylesheet reference in each packaged HTML page
resolves to an archive entry.

**A failure means:** a transport hit outside the favicon service is the serious one. Read the
match before reacting, since a test helper or a comment can match. A missing entry point means the build and the manifest disagree,
which ships a broken extension.

## Step 5. Recapture the five canonical screenshots

The step most likely to be skipped. The five screenshots in `store/assets/screenshots/` are only as
current as the last capture, and any change to the popup, the overlay, the gate, Options or Stats
makes them pictures of a product that no longer exists. Recapture them whenever the surfaces have
moved since the last release.

**Needs a quiet machine.** Real browser, real capture.

```bash
TZ=Europe/Amsterdam STORE_SCREENSHOT_EXPECT_HOST_TIMEZONE=Europe/Amsterdam \
  UPDATE_STORE_SCREENSHOTS=1 npx playwright test tests/e2e/store-screenshots.spec.ts \
  -g "captures five truthful release states"
TZ=Europe/Amsterdam npx playwright test tests/e2e/store-screenshots.spec.ts
git diff --stat store/assets/screenshots/
```

Capture first, then run the whole file. The inventory and timezone checks appear before the capture
test, so a single unfiltered update run checks the old images before replacing them.

**Proves:** the five canonical PNGs are regenerated from the current build at 1280x800, opaque, with
the exact capture geometry the spec annotates, and the host and worker clocks agree on
`Europe/Amsterdam`, which is what makes the captures reproducible.

**A failure means:**

- **A timezone assertion fails.** The host is not on Amsterdam time. Set `TZ` as above rather than
  changing the spec, because the constant exists so two people on different continents produce the
  same bytes.
- **The update mode is rejected.** `UPDATE_STORE_SCREENSHOTS` must be exactly `1`.
- **`git diff --stat` shows no change.** Suspicious rather than good. Either the capture did not
  publish or the surfaces genuinely did not move. Confirm which before believing it.

**Read the provenance check for exactly what it claims.** A matching digest proves a capture was
run against a `dist/` with that digest. It does not prove the tracked bytes are what that capture
produced, and those are different claims with the stronger one implied by the name. The pixel
comparison inside step 7 does make the stronger check, so the gate is not blind, but a green step 5
on its own earns less than a reader would assume.

Then look at all five. **This is the step that needs a person, and it is the reason this gate
cannot be finished by an agent.** The provenance digest proves the images came from this build and
the inventory check proves they are 1280x800 and opaque. Neither can tell you that a screenshot is
cropped through a heading, shows an empty state where the feature should be visible, or documents a
flow in an order nobody uses. Record it in step 8 as outstanding until somebody has actually
looked.

## Step 6. Install the exact packaged artifact

**Needs a quiet machine.**

```bash
npx playwright test tests/e2e/package-install.spec.ts
```

**Proves:** the artifact a reviewer would download actually installs. The spec reads
`release/package-manifest.json`, extracts that ZIP into a fresh temporary directory, and loads only
the extracted directory. It never loads `dist/`, which is the point: this is the only check in the
gate that answers "does the packaged thing work" rather than "does the built thing work".

**A failure means:** it depends on `store:package` having run, and fails loudly if the manifest is
missing. If it fails immediately with a missing package manifest, you skipped step 3. If it fails
inside the browser, the packaged artifact is broken in a way no earlier step can see, and that
blocks submission absolutely.

## Step 7. Full browser verification

**Needs a quiet machine, and this is the long one.**

```bash
NO_COLOR=1 npm run e2e
```

**`npm run e2e` is `npm run store:package && playwright test`.** It packages first, so a packaging
failure here is not one red test, it is the entire gate failing before a single browser opens, and
the error you see will be from the packager rather than from a scenario. Read the first failure, not
the last.

**The visual capture inside this suite takes about 25 minutes on an idle machine and does not
finish on a busy one.** Budget for it, and do not start it if anyone else is working.

**Proves:** every onboarding, permission, storage, popup, blocking, Stats, restart, gate, indefinite
and screenshot scenario passes with zero unexpected diagnostics.

**A failure means:** distinguish five kinds before reporting, and re-run the failing file alone on
a quiet machine before deciding which. That re-run is the highest-value step in the whole gate. It
has taken a list of nine failures and shown which were deterministic, which passed alone, and which
had been assigned to the wrong person.

1. **A packaging failure at the very start.** Step 3's problem, and the error comes from the
   packager rather than from a scenario.
2. **An environment failure.** A visual spec timing out on a loaded machine, or the signature
   `Test timeout of Nms exceeded while setting up "<fixture>"`, which means the fixture setup ran
   out of budget before the test body ever started. A per-test timeout does not cover fixture
   setup, and building one of these fixtures is several browser launches.
3. **A test asserting something the product no longer does.** The most misleading kind, because it
   looks exactly like a regression while being the opposite: a defect was fixed underneath it. You
   meet it as a plain value mismatch where the received value is the product's new, correct answer,
   `Expected: "paused" Received: "focus"` or `Expected: "website-access-lost" Received:
   "invalid-request"`, and the temptation is to read the expected side as the truth. Check what
   landed recently in the code under the assertion before assuming the test is right. Five
   scenarios failed this way in one session, including a snapshot read that assumed a serialisation
   the worker had deliberately given up, and a start rejection whose code had moved to the boundary.
4. **A scenario driving a deliberate refusal without declaring it.** The worker reports refusals it
   is designed to make, and every fixture forbids worker errors. You meet it as
   `unexpected browser diagnostics: {...}` with a `workerErrors` array whose message is the refusal
   the scenario exists to assert, often repeated many times because the refusal retries, and with
   every other bucket empty. That last detail is the tell: a real defect rarely produces one message
   and nothing else. Any scenario that drives one needs `beginExpectedWorkerErrorWindow` from
   `tests/e2e/browser-diagnostics.ts`, which requires the declared error to arrive and stays strict
   about every other one. Expect more of these as error reporting spreads, and expect all of them to
   look like new breakage.
5. **A real defect.** What is left after the four above are excluded, and only then.

Two expected results that are not failures. A **skip** in `tests/e2e/indefinite.spec.ts` about one
run in eight. Whether a fresh navigation can be stopped is Chrome's content-script injection timing
rather than a product rule, and that scenario checks the worker's own durable stop record instead of
asserting into the race. And the three schedule scenarios skipping together within twenty minutes of
local midnight, for the reason in the constraints above. Count the skips against a run you trust
before reading a low number as a clean sweep.

## Step 8. Record the evidence and commit

```bash
npm run qa:checklist
git status --short
git add docs/qa-checklist.md store/release-checklist.md
git commit -m "docs: record Chrome Web Store release candidate"
```

Record, in `store/release-checklist.md`: the commit hash from step 0, the Chrome-for-Testing
version, what each step produced rather than that it passed, the archive path and its SHA-256, the
recaptured screenshot digests, and the manual-gate items still outstanding.

**Re-read the archive digest here rather than carrying step 4's forward.** Step 7 is
`store:package && playwright test`, so it repackages, and the file step 4 inspected has been rebuilt
since. Nothing fails to warn you: the gate passes, the checklist is signed, and the recorded digest
simply names an archive that no longer exists, which anyone checking it later cannot reproduce.
Record the digest of the archive that exists at the end of the gate, which is the one a reviewer
would download.

`store/release-checklist.md` is created by this step rather than kept empty in the tree between
releases. An empty release checklist reads as a completed one to the next person who finds it.

**Mark the privacy URL as `awaiting master deployment`, not as passed.** It cannot be true yet, and
the reason is in step 9.

## Stats evidence parity, and why the gate does not run it

Not a gate step. Run it when the Stats surfaces have changed and you want the cross-check that the
production capture agrees with the development one, which is two assertions the ordinary suite never
reaches.

```bash
npm run stats:dev-evidence
npm run stats:evidence
```

The first captures development evidence into `artifacts/stats-task5/dev`, including
`stats-dev-run-report.json`. The second re-runs the Stats matrix with `STATS_EVIDENCE_DIR` pointed
at `artifacts/stats-task5/production`, which is the only condition under which the matrix compares
seed parity and rendered geometry against that report. Without it, those two
`expect(...).not.toThrow()` calls are skipped entirely, so a default run counts them as coverage it
did not obtain. Both commands write inside `artifacts/`, which nothing else here does.

**Run it separately from the gate, never as part of step 7.** Setting `STATS_EVIDENCE_DIR` also adds
`--disable-gpu --disable-gpu-compositing` to every browser launch in the run, not only to the
capture that asked for it, so folding it into step 7 would certify all eighty-one scenarios under a
rendering configuration nothing else was measured under. Fixing two unreachable assertions by making
eighty reachable ones less trustworthy is a bad trade. The launch site names the coupling, and an
explicit `deterministicPaint` option now exists beside it for callers that genuinely need a stable
paint. Retiring the variable arm is post-merge work, because the captures already on disk were
taken under those flags.

One note for anyone auditing this the way it was found. The producer of that report,
`scripts/capture-stats-dev-evidence.ts`, was first reported as not existing, because a search for
the literal `stats-dev-run-report.json` missed a script that assembles the path from constants. That
mistake has now been made six times on this branch. When a search for a path comes back empty, search
for the directory, the constant and the writer before believing it.

## Step 9. What this gate does not certify

The gate makes the branch a release candidate. It does not make the listing submittable, because the
privacy policy URL in `store/listing.md` and `store/privacy-disclosures.md` points at
`https://wolph.github.io/distraction-blocker/privacy/`, and `.github/workflows/pages.yml` publishes
that page only on a push to `master`. The URL 404s until the branch merges and the workflow runs.

So the order at the end is: gate passes, branch merges to `master`, Pages workflow deploys, then

```bash
curl --fail --silent --show-error https://wolph.github.io/distraction-blocker/privacy/ > /dev/null
```

and only then is the listing's privacy URL a true claim. No amount of gating on a branch can bring
that check forward, which is why step 8 marks it awaiting rather than skipping it.
