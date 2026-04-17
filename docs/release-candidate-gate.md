# Release-candidate gate

Run this before submitting Focus Lock to the Chrome Web Store. Follow it in order. Every step names
the command, what a pass proves, and what a failure means, because most of these fail in more than
one way and the difference decides what you do next.

Several of the steps report by what they produced rather than by their exit code, and the difference
matters more here than anywhere else in the repository: a green exit on a stale artifact is the
failure this gate exists to prevent.

**Read these five constraints first. Three of the steps are destructive of other people's work if
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
- **Start from clean evidence directories.** `artifacts/` is shared mutable state exactly as `dist/`
  is, and the evidence specs verify a directory's contents against a manifest. Leftover files from
  an earlier or repeated run fail that parity check, and the failure names the directory rather
  than the cause. `Task 5 Stats responsive evidence matrix` fails this way inside a full-file run
  and passes alone. Clear the evidence directory a step is about to write, or expect to spend the
  triage.
- **Nothing here may run against a dirty or moving tree.** Step 0 establishes that, and step 5's
  whole purpose is defeated if a commit lands mid-gate.

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

That is `biome check . && tsc --noEmit && vitest run && npm run build`, in that order, stopping at
the first failure.

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
  one shared fixture or one contract change rather than for many small breaks.
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

This is the one step worth running before the gate rather than during it. A stale inventory is a
commit rather than a rerun, and you do not want to discover that between two browser steps.

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
are present, and no unreviewed network transport has appeared in the product code.

Also confirm by inspection, because the validator does not: every entry in the archive has a
counterpart under `dist/` and is byte-identical, every declared entry point in the manifest resolves
inside the archive, and every local script and stylesheet reference in each packaged HTML page
resolves to an archive entry.

**A failure means:** a transport hit is the serious one. Read the match before reacting, since a
test helper or a comment can match. A missing entry point means the build and the manifest disagree,
which ships a broken extension.

## Step 5. Recapture the five canonical screenshots

The step most likely to be skipped. The five screenshots in `store/assets/screenshots/` are only as
current as the last capture, and any change to the popup, the overlay, the gate, Options or Stats
makes them pictures of a product that no longer exists. Recapture them whenever the surfaces have
moved since the last release.

**Needs a quiet machine.** Real browser, real capture.

```bash
TZ=Europe/Amsterdam STORE_SCREENSHOT_EXPECT_HOST_TIMEZONE=Europe/Amsterdam \
  UPDATE_STORE_SCREENSHOTS=1 npx playwright test tests/e2e/store-screenshots.spec.ts
git diff --stat store/assets/screenshots/
```

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

Then look at all five. This is a human step and cannot be delegated to the spec: the capture proves
the pixels are current, not that they show the product well.

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

One expected result that is not a failure: a **skip** in `tests/e2e/indefinite.spec.ts` about one
run in eight. Whether a fresh navigation can be stopped is Chrome's content-script injection timing
rather than a product rule, and that scenario checks the worker's own durable stop record instead of
asserting into the race.

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
