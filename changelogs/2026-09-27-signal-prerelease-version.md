# Accept exact Signal prerelease versions

Signal startup version pinning now accepts valid SemVer prerelease and build identifiers, such as `0.14.9-SNAPSHOT`, while preserving exact string matching against the supervised `signal-cli` child. Noncanonical versions, including a leading `v`, leading-zero core numbers, and numeric prerelease identifiers with leading zeros, remain rejected.

This allows a reviewed prerelease build to stay truthfully named instead of being restamped as an official release.
