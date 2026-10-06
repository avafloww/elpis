# Recover workflow-owned release preparation

Release subject aliases can now explicitly relabel an earlier untagged reserved release subject. Existing ordinary conventional subjects still cannot be aliased; the bounded count, earlier-target, body-size, and valid replacement checks remain.

This provides an append-only recovery path when a manual version-state commit was already published before the release workflow could own the bump, without rewriting public history.
