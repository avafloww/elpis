# Update reported Codex client version

The Codex OAuth transport and model discovery requests now report client version
`0.156.0`. This lets the backend use the current Codex client compatibility
and model catalog when resolving newer models such as `gpt-6-sol`.

Updated the focused wire assertions for the `version` header and discovery
query. `npm run test:unit` and `npm run build` passed.
