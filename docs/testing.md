# Testing

Elpis uses Node's test runner with TypeScript loaded through `tsx`.

## Commands

```bash
npm run test:unit       # deterministic suite with network disabled
npm run build           # TypeScript compile + console assets
npm test                # full suite, including environment-sensitive tests
npm run test:full-report
npm run test:integration
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

`TEST_NO_NETWORK=1` disables live network paths. A public CI workflow should run the deterministic suite and build.

## Expectations

Bug fixes should reproduce the failure in a focused test before changing implementation. Tests must assert the externally meaningful contract, not a private timestamp, person, host, or development task number.

A green unit test for a diagnostic is not enough: after deployment, deliberately trigger the real failure and verify the message reaches the intended observer.

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
