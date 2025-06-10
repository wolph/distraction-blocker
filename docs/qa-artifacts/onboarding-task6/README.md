# Onboarding Task 6 evidence

This directory preserves the complete onboarding visual review in repository-relative form. The two archives use `tar.gz`, which the default `tar` command can extract on macOS and Linux. Every archive name is its SHA-256 digest.

## Contents

- `archives/e9212cbda6e84f19b8f4d998eba719380ea1faf9e4ab8517c18c67c2e7d98a7b.tar.gz`: 16,585,380 bytes. Contains all 528 development-server PNGs and `manifest.json`.
- `archives/aefeeec2f37b11a342bf392d5df957cebb08f6fb20409a60ecad046b31233d4c.tar.gz`: 8,950,366 bytes. Contains all 372 production PNGs and `manifest.json`.
- `manifests/`: standalone copies of the development-server, production, and real-prompt manifests.
- `real-prompt/`: all six browser-chrome PNGs from the no-mock Chrome-for-Testing run.

The production manifest discloses the two scoped `chrome.runtime.sendMessage` interceptions used to synthesize pending completion and one failed setup load. It records 12 expected and 12 observed calls for each interception. All other production extension behavior used the real unpacked extension. Only the separate real-prompt manifest claims `mockedChromeApis: false`.

## Verify

Run the cross-platform verifier from the repository root:

```bash
node docs/qa-artifacts/onboarding-task6/verify.mjs
```

The verifier checks each content-addressed archive filename, rejects unsafe archive member paths, extracts through the platform `tar`, compares the archived and standalone manifests, verifies every PNG signature, size, and SHA-256 digest, rejects unlisted PNGs, and checks the interception disclosure.

Extract either archive manually with the same command on macOS or Linux:

```bash
mkdir -p /tmp/focus-lock-task6-production
tar -xzf docs/qa-artifacts/onboarding-task6/archives/aefeeec2f37b11a342bf392d5df957cebb08f6fb20409a60ecad046b31233d4c.tar.gz -C /tmp/focus-lock-task6-production
```
