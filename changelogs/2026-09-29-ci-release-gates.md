# Restore CI release gates

The release workflow had stopped in `bench:check` after `DiscordWiring.send` became required: the benchmark runtime still returned the older adapter shape, so every push skipped release publication. The benchmark adapter now exposes the same synthetic send function it already installs on Agent.

The repaired workflow then exposed three production dependency advisories. Exact same-major overrides now select patched `fast-uri`, `ip-address`, and `undici` releases; the lockfile remains compatible with plain `npm ci`.

A clean install followed by the workflow's full source gate chain passed: deterministic tests, Gateway tests, tool typecheck, both builds, benchmark typecheck, and the production audit with zero vulnerabilities.
