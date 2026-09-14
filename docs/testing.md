# Testing

Elpis uses Node's test runner with TypeScript loaded through `tsx`.

## Commands

```bash
npm run test:unit        # deterministic suite; live/host cases skipped
npm run build           # TypeScript compile + console assets
npm test                # full suite, including environment-sensitive tests
npm run test:full-report
npm run test:integration
npm run test:gateway     # Gateway protocol and service workspace suites
npm run bench:check
```

Tests import `src/` directly. Production and subprocess acceptance use `dist/` after a fresh build.

## Test layers

- pure unit tests for parsers, transforms, stores, routing, and request translation;
- loop tests that drive a real `Agent` with fake providers and channels;
- persistence tests using temporary directories and SQLite databases;
- provider-wire tests with captured synthetic streams;
- browser/console tests over the static client and hub protocol;
- opt-in live integration tests requiring configured services.

`TEST_NO_NETWORK=1` skips environment-sensitive cases, including the privileged host `sudo` check. It is a test convention, not a network sandbox: deterministic HTTP/WebSocket tests still use loopback servers. A public CI workflow should run the deterministic suite and build. Run the Gateway suite when changing that workspace; the root unit command includes provider transport but does not include the Gateway service or protocol suites.

## Expectations

Bug fixes should reproduce the failure in a focused test before changing implementation. Tests must assert the externally meaningful contract, not a private timestamp, person, host, or development task number.

A green unit test for a diagnostic is not enough: after deployment, deliberately trigger the real failure and verify the message reaches the intended observer.

## Choosing useful coverage

Before adding a test, identify the failure it would detect and check whether an existing test already detects it. A small test of a parser can be valuable; a large test that searches for implementation strings can prove very little. Prefer a focused behavioral assertion over either test-count growth or a new test framework.

The cleanup found several recurring sources of noise:

| Avoid                                                                              | Use instead                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Searching JSX/CSS for classes, handlers, or a particular component expression      | Browser interaction for UI behavior; reducer tests for state transitions           |
| Looking for MIME declarations in server source                                     | Fetch an actual asset and check the response headers and bytes                     |
| Checking that emitted JavaScript mentions `globalThis` or a temporary variable     | Execute the transform, then read the binding in a later evaluation                 |
| Repeating exported arrays, dependency versions, or artwork digests in expectations | Test the consumer's contract; let builds and container boot probes check packaging |
| Asserting that a forbidden string is absent without supplying it                   | Seed forbidden fields and allowed values, then inspect the boundary's output       |
| Calling a marker sample “lossless”                                                 | Reconstruct and compare the entire input                                           |
| Tight timing ceilings and repeated real sleeps                                     | Advance a virtual clock or release a controlled promise                            |

The existing Console browser acceptance exercises the built app with synthetic state; see [Console](console.md). It covers reconnects, draft preservation, streaming, composition-safe sends, room selection and dimming, and absence of service-worker response caching. Unit tests of projections do not replace that browser pass. Container source checks remain supplemental static guards; the release workflow's image build and boot probes provide packaging acceptance. Parsed Kubernetes permission checks describe the shipped manifest, not an effective cluster network boundary.

### Prompt tests

Prompt assembly is software behavior. Keep coverage for which layers and capabilities are included, what changes across configurations, which cache tiers refresh, which private inputs are withheld, and whether segmentation preserves all text. Exact speech-header syntax and section delimiters used by a parser also warrant checks.

Ordinary advice is not a machine protocol. Avoid sentence-by-sentence snapshots of unchanged prose or tests claiming a model follows a rule because it appears in the prompt. A narrowly chosen privacy or authority instruction can be checked as a delivery contract, preferably on the actual assembled request. It still does not establish model obedience. Judge wording through review and, when making behavioral claims, representative model evaluations. Do not introduce live model calls into the unit suite for copy edits.

### Removing tests

Remove redundant or misleading checks without replacing them merely to preserve a count. If a weak check is the only coverage for an important boundary, replace it at the point where the effect is observed. Keep deterministic hostile-input, ordering, migration, privacy, and replay tests even when their fixtures are lengthy. A test's size or extensive mocking alone is not evidence that it is useless.

## Fixtures

Use synthetic identities and infrastructure:

- agent: Aster;
- operator: Bramble;
- other person: Clover or Rowan;
- domains under `example.com` or `.test`;
- synthetic Discord snowflakes.

Never use a real transcript, credential, Discord identifier, private hostname, or household detail as a fixture.

## Environment-sensitive failures

The full suite may require provider credentials, Discord, Docker, Kubernetes, or desktop services. Report those failures separately from deterministic regressions. Do not describe the whole suite as green when only the network-free portion passed.
