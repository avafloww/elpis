# Repair native voice dependency container builds

The resident container build stage now installs Python and the standard compiler toolchain before `npm ci`. This lets `@discordjs/opus` compile from source when a matching Node 24 prebuilt binary is unavailable.

The toolchain exists only in the disposable build stage and is not copied into the restricted runtime image. Runtime permissions, packages, configuration, and voice enablement are unchanged.

Validation includes a stage-boundary regression, the full deterministic suite and build, and an exact release-container build.
