# Six rules for tests in this repository

Each of these was learned the expensive way on one branch. They are written with the evidence that
earned them, because the evidence is the part that makes them stick.

## 1. A guard that passes on its first run has told you nothing

Write a test, watch it pass, and you have learned less than you think. The code was never wrong, so
the test never had a chance to fail. That is the moment you know least about it.

Break the thing the test protects, run it, and watch the named test go red. Then repair the code.
One command, and it is the only thing separating a guard from a restatement.

This is not a hypothetical. Seven checks in this repository passed on their first run and could not
have failed, and each was wrong in a different way:

- An assertion run against whitespace-collapsed text when the rule was about line structure, so a
  line-anchored pattern could never match.
- A value compared against itself.
- A duplication check that grepped a constant's name, which occurs once by construction, when the
  rule was about the strings the constant holds.
- An assertion satisfied by exactly the defect its own comment named, three lines below the comment.
- A count checked by running the same arithmetic on both sides of the assertion.
- A completeness claim that rested on a file appearing in a diffstat.
- A source-text scan of a file when the rule was about the copy inside it, which found `KeyboardEvent`
  and `onKeyDown` and called them product copy.

The shape is the same every time. **The thing checked was not the thing the rule is about.** A grep
for a symbol is a proxy for the runner's answer. A scan of file text is a proxy for the copy. A
transformed value is a proxy for the value. Proxies fail silently, which is why the first run is
green and why nobody looks again.

## 2. Run the whole suite before committing a shared contract

Scope the test run to the rule's reach, not to the files you edited.

A change to a validator, to anything in `src/shared`, or to a type every fixture builds, has a blast
radius of every fixture that validator sees. Those live in files you did not touch, which is exactly
why a scoped run is green.

One correct fix to a frozen view's contract left nine test files and one hundred and forty-eight
tests red, from a single shared builder that had the old value baked in. The scoped run before the
commit was green. Another engineer's gate run found it forty minutes later.

A partial suite is a check scoped to the author's edit rather than to the rule's reach.

## 3. A fake that is more permissive than the real thing hides real defects

Every fake is a claim about the world. A fake that always succeeds claims a world where that step
cannot fail, and every test written against it inherits the claim.

Three in this repository were more generous than production and each hid something:

- An acknowledgement fake that answered every command as applied, so no test could see a document
  that refused.
- An identity minter that produced values the real validator would have rejected, so no test ran
  against the identities production actually mints.
- A tab-claim resolver that resolved every claim by construction, while the browser resolves only
  the tabs it can still find. That one hid a live defect: a claim carrying a tab identifier from
  before a restart can never resolve, because the browser renumbers restored tabs.

When a fake models a step that can fail, give it a way to fail, and write the failing case. When it
cannot, say so in a comment where the next reader will look, so the gap is documented rather than
discovered.

## 4. Pin the requirement, not the behaviour, and let the test go red

When a review finds a defect that is not being fixed yet, write the test to the requirement and mark
it as expected to fail. Do not write it to what the code currently does.

A test pinned to current behaviour agrees with the defect. It turns green forever, it reads as
coverage, and when someone finally fixes the code that test fails and looks like the regression.
Three tests in this repository asserted a defect as intended behaviour, one of them named for it,
and each had to be rewritten rather than updated when the fix landed.

A test pinned to the requirement goes red the moment the defect is repaired, which forces the update
and makes the fix visible in the diff. That is the behaviour you want from a suite: it should
disagree with the code until the code is right.

## 5. A frozen clock ages, and a test frozen to a date fails on the next one

Freezing time makes a test deterministic. Freezing it to a fixed timestamp makes it deterministic
until that day passes, and then it fails for a reason nobody changed.

The store screenshot capture froze every clock at a timestamp written into the file on the first of
September. It passed that day. From the second, the day it seeded stopped being today, so the daily
totals read zero while the seven-day total kept matching, because that window does not care which
day it is. That split is the tell: one figure wrong and its neighbour right, where the neighbour is
the one whose question the frozen day cannot spoil.

The same rot hid a second failure behind the first. A session started on a clock frozen in the past
asks `chrome.alarms` for a boundary that has already gone, and the browser answers with no alarm,
which the read back reports as `alarm-failed`. That is the constraint to carry: **a frozen clock and
real alarms cannot both hold.** The alarm scheduler runs on the real clock whatever the page
believes, so any instant you freeze has to stay ahead of it.

Freeze to an instant derived at run time, not to one typed into the file. Pick the property the
scenario actually needs from that instant, a morning in a named timezone, a day boundary not yet
crossed, and compute the next one that satisfies it. The capture that failed now freezes at the next
morning in the store timezone still ahead of the real clock, which keeps the hostile-timezone run on
a different calendar day and keeps the alarms schedulable.

## 6. A comment is prose, and the file it sits in will not tell you

The project's writing rules apply to every word anyone reads: documentation, commit messages, and
the comments in a test. Straight quotes, ASCII hyphens, no ellipsis character, and no semicolons
joining two sentences that a period would join better.

Documentation is the easy half. Someone writing a document expects prose rules, because a document
is obviously prose. A comment in a test is where the rule fails, and the reason is the file around
it. Three lines above your comment a semicolon ends a statement and is correct. Inside the comment
block it is punctuation and is not. Nothing marks the boundary: the formatter reads the whole file
as TypeScript and is happy either way, the type checker has no opinion about English, and a review
reads comments for what they say rather than for how they are punctuated.

So the only thing that finds these is a deliberate scan, which means they accumulate until somebody
runs one. When this rule was written, a scan across one branch's authored files found exactly two
violations in prose, and **both were in test comments**. None were in the documentation the same
people wrote in the same week.

Two exemptions, and they are the same exemption twice. Literal command text keeps its own
punctuation, and so does code inside a JSDoc `@example` block, because both must run as written and
rewriting them to satisfy a rule about English would break them. Say so when you exclude them from
a scan rather than passing over them silently, so the next reader knows the call was made and by
whom.

## The common thread

The first five are the same question asked at different scales. **Is the thing you checked the
thing you meant?** A proxy value, a partial suite, a permissive fake, a test pinned to the current
behaviour, and a clock pinned to a date that has passed are five ways of answering a question next
to the one you asked, and all five come back green until the day they do not.

The sixth is the same question about the words rather than the code. A comment that explains the
wrong thing, or explains the right thing in prose nobody edits to the standard the documents get,
is a check on the reader's understanding that nothing runs.
