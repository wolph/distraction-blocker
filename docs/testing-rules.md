# Four rules for tests in this repository

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

## The common thread

All four are the same question asked at different scales. **Is the thing you checked the thing you
meant?** A proxy value, a partial suite, a permissive fake, and a test pinned to the current
behaviour are four ways of answering a question next to the one you asked, and all four come back
green.
