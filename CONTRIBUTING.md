# Contributing

Elpis is developed as a lived single-agent runtime. Contributions are welcome when they preserve continuity, privacy, and operator/inhabitant neutrality.

Before opening a pull request:

1. Read `AGENTS.md` and the relevant area document.
2. Keep fixtures synthetic; never include transcripts, credentials, real Discord IDs, private hosts, or personal examples.
3. Add tests for behavior changes and bug fixes.
4. Run `npm run test:unit` and `npm run build`.
5. Update docs and `config.example.yaml` with the code they describe.

Pull requests should explain the invariant being changed, the failure mode addressed, and how the result was verified. Large architectural changes should begin as an issue or discussion before implementation.
