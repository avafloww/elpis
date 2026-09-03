# Contributing

Elpis is developed as a lived single-agent runtime. Contributions are welcome when they preserve continuity, privacy, and operator/inhabitant neutrality.

Before opening a pull request:

1. Read `AGENTS.md` and the relevant area document.
2. Keep fixtures synthetic; never include transcripts, credentials, real Discord IDs, private hosts, or personal examples.
3. Add tests for behavior changes and bug fixes.
4. Run `npm run test:unit` and `npm run build`.
5. Update docs and `config.example.yaml` with the code they describe.

Pull requests should explain the invariant being changed, the failure mode addressed, and how the result was verified. Large architectural changes should begin as an issue or discussion before implementation.

Commits reaching `main` must use Conventional Commit subjects. Do not rewrite already-published history solely to repair a malformed subject. As a last-resort release recovery, a later `fix(release): ...` commit may carry `Release-Subject-Alias: <full earlier SHA> <conventional subject>` in its body. The workflow accepts only bounded, exact aliases for earlier malformed commits in the same unreleased range; it rejects aliases for valid, missing, current, later, reserved release, or multiply-aliased commits. The recovered subject is used consistently for version classification and release notes.
