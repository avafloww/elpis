# Private resident run-token propagation

For each successfully parsed live `run` call, Agent now issues the exact committed assistant-batch ordinal's single-use process-local token. `SandboxManager` accepts it before sandbox creation or execution, rejects invalid, replayed, cross-authority, wrong-tool, or explicitly invalid-present tokens without silently downgrading, and stores only the resulting opaque handle for that invocation.

Every sandbox invocation receives a fresh `RunScope`. The canonical sandbox and manager lifecycle associate the handle with that scope, mark it detached synchronously when the async deadline wins, and close it on ordinary completion, failure, preparse, detached settlement or cancellation, manager disposal, or restart. Persistent VM reuse does not inherit a prior invocation's handle. Calls without a token keep their prior behavior.

This stage adds no resident-visible authorization or action API and grants no contract, identity, profile, branch, provider, effect, destination, activation, or continuation authority. Tokens and verifiers do not enter `SandboxDeps`, VM globals, transcripts, or provider requests; restored forensic records cannot recreate process-local authority.
