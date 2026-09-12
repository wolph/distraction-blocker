# Chrome Web Store release candidate 0.1.0

Candidate source: `5a8d58bd95b6076ce0ee56ac8961332f0afb95d7`. Verified on 12 September 2026 with Node.js 24.18.0 and Chrome for Testing 151.0.7922.34.

## Verification

- Lint and TypeScript passed. All 177 unit files passed, with 4,825 tests passed and eight skipped.
- Store build, package validation, QA inventory and privacy-page validation passed.
- Both packaged-installation scenarios passed.
- The full browser suite passed 111 scenarios, with three expected skips.
- The skipped scenarios cover an unreachable registration-audit state and two opt-in visual capture commands. No local-midnight schedule guard was triggered.
- All four focused native-popup, narrow-layout and scroll-reachability scenarios passed. The native width assertion remains exactly 480 pixels.
- All 28 focused popup layout and control unit tests passed.
- Visual inspection covered full-page and component screenshots at 1200, 768 and 375 pixels, hover states and a 375 by 400 pixel viewport. Inner scrolling remained available. No browser errors were recorded.
- All five Store screenshots were recaptured from this build. All nine screenshot checks passed, including strict PNG comparison under the isolated timezone case.
- Browser verification retained the same 40-file build inventory before and after each recorded stage.
- The public [privacy policy](https://wolph.github.io/distraction-blocker/privacy/) returned HTTP 200 and matched the validated local page.

The popup root disables its unused scrollbar to avoid phantom scrollbar padding in affected Chrome autosizing. Inner scroll containers keep their existing behaviour. The corresponding [Chromium fix](https://chromium.googlesource.com/chromium/src/third_party/+/4280dbe5760dad58f95abd1ebc1b0b0f06948be6) documents the browser regression.

## Package

- Archive: `release/focus-lock-0.1.0.zip`
- SHA-256: `834dc061f388463df6a7e6761305602138c206362a8392604169701738f1967b`
- Build tree SHA-256: `4e99bfe767180f01d03d1ebd142ecd5693f4c216a051d728562210ecc1f3f620`
- The archive contains 40 files, each byte-identical to its counterpart in `dist/`.
- All eight manifest references and 50 HTML asset references resolve.
- The Store manifest omits the development key. Package validation rejects a manifest key, unexpected files and missing assets.

## Screenshots

Captured at `2026-09-12T12:38:33.853Z`. The capture uses declared demonstration data and clears pointer hover and keyboard focus before recording native controls.

| Screenshot | SHA-256 |
| --- | --- |
| 01-start-session.png | `49c82ec940576348c37457bf90b99f39180ae65ac7b91e1af17c9a236e9fc324` |
| 02-blocked-page.png | `2b35d9536126a85c02a1ce16a799914d610e4bca1258a88833dc6636eed589af` |
| 03-onboarding.png | `673bc3b3d7f4c79fa3d00f839347675c5966971c7263f27d3f28a6a1895c2bfd` |
| 04-stats.png | `4bcb2e4a9661269b00a86f1d6d2c30be7b644d3a99d21d05ac6cd9f1722da5e4` |
| 05-privacy-data.png | `fb9bbf2970dca94e03df8edeb74467c002a26ec6bb2fddbc07760c2c61e99589` |

## Outstanding submission steps

- Human review of all five screenshots remains outstanding. [Release gate step 5](../docs/release-candidate-gate.md#step-5-recapture-the-five-canonical-screenshots) explicitly requires a person to look at them.
- The Chrome Web Store item is a saved draft. The final package and all five screenshots have been uploaded from the files identified above. Submission remains pending the human screenshot review.
- Store review and publication remain pending. These checks do not represent approval by Google.
