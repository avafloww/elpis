# Coding-agent MCP

Elpis can expose its canonical Mind work graph to authenticated external coding agents over MCP Streamable HTTP.

```yaml
console:
  enabled: true
  mcp_enabled: true
  host: 127.0.0.1
  port: 8787
```

The endpoint is `POST/GET/DELETE /mcp` on the console server. It is disabled by default.

## Security boundary

The harness does not implement public-network authentication for MCP. Keep the console loopback-bound and either use an SSH tunnel or place it behind TLS and authentication. The endpoint rejects every request carrying an `Origin` header, so browser pages cannot use an authenticated console session as ambient MCP authority.

MCP sessions use random in-memory IDs. Clients should finish or release claimed work before terminating a session. Abandoned sessions are reaped after six idle hours and all sessions disappear on restart; durable claims remain unavailable to other workers only until their bounded lease expires. Request bodies are limited to 1 MiB.

A reverse proxy should disable request/response buffering for `/mcp`, preserve the `Mcp-Session-Id` header, and use a long read timeout. When Basic Auth is the outer gate, clients can send an `Authorization` header in their MCP transport configuration:

```json
{
  "mcpServers": {
    "elpis": {
      "type": "streamable-http",
      "url": "https://console.example.test/mcp",
      "headers": {
        "Authorization": "Basic <base64-user-colon-password>"
      }
    }
  }
}
```

Credential syntax varies by client. Never commit the header value.

## Collaboration model

MCP is an adapter over the same `MindService` used by `elpis.mind`, `/mind`, reminders, and the console dashboard. There is no second task database. External clients are bounded collaborators, not parallel instances of the resident agent.

Mutations are attributed from MCP initialization metadata as `mcp:<sanitized-client-name>`. Callers cannot choose their audit actor. Claims also carry an unexposed session-specific principal so two instances of the same client cannot accidentally own one task.

Only dependency-ready `open` tasks are discoverable or claimable as coding work. Ideas, questions, projects, inbox records, waiting/blocked work, and work already in progress outside MCP remain visible through ordinary reads but cannot become accidental worker commitments.

## Result contract

Every tool declares an object-root output schema and returns native `structuredContent`. Successful envelopes contain `ok: true` and `data`, with compact mutation `receipt` or list `page` metadata when applicable. Domain/runtime failures contain `ok: false` and a stable `error` with `code`, `message`, and `retryable`. Calls rejected by the MCP input schema never reach the tool handler and therefore remain protocol-level invalid-parameter errors; preserving strong advertised schemas is preferable to weakening validation merely to force one error envelope. Text content is a compact continuation summary, not a duplicate of structured data.

Lists, ready work, discovery, and graphs return compact item summaries. Summaries expose archival state, active and total child counts, claim/resume/update/comment capabilities, and an ISO mirror for `dueAt`. `mind_get` and `mind_context` accept `include` parts (`body`, `relations`, `comments`, `events`, `reminders`) plus bounded comment/event limits; events are newest-first. `mind_list` returns `next_cursor` and `total_count`; `offset` remains a compatibility input but must not be combined with `cursor`.

## Worker workflow

1. Call `mind_discover` while repository/task context is fresh, or `mind_context` for an assigned item. `filter_tags` strictly constrain candidates (`filter_mode` is `all` by default); `boost_tags` only affect rank. The old `tags` input remains a compatibility alias for boosts.
2. Call `mind_claim` before implementing an executable task. The atomic lease fails if another worker owns it. Ideas, questions, projects, and reminders are non-claimable metadata records; their ordinary metadata/comments may still be maintained. Default lease duration is 30 minutes; `mind_renew` extends long work.
3. Use `mind_log` for progress, decisions, results, verification, and omissions. Logging also renews the lease. `mind_comment` remains available for ambient notes that are not claimed coding work.
4. Call `mind_ask` before guessing about architecture, external behavior, security/privacy, conflicting scope, or ambiguous acceptance criteria. It wakes the resident agent and waits for an exact structured reply. If its bounded wait expires, call `mind_await` once with the returned cursor; no `mind_get` spin loop is required. `mind_message` remains the immediate-return compatibility path.
5. Call `mind_block` to record a blocker, release the lease, and move the item to `waiting`; once resolved, `mind_resume` atomically returns dependency-ready waiting work to `in_progress` under a new lease. Call `mind_release` to return unfinished claimed work to `open`.
6. Call `mind_finish` only after work is verified. It requires result, verification, and omissions receipts, writes them as one durable comment, releases the claim, and marks the item `done` in one transaction. Generic `mind_update` cannot change lifecycle status.
7. Test clients may call `mind_archive_created` with explicit IDs. It can archive only records created by that exact in-memory MCP session; another same-named client has no authority. It never deletes history.

Expired claims are returned to open work with a visible system comment and audit event. Claim, status, comment, and lifecycle event changes are committed atomically. Time-bearing metadata such as `due_at` accepts either epoch milliseconds or ISO-8601 strings and is stored as epoch milliseconds.

`mind_graph.relations` selects any combination of `dependencies`, `dependents`, `parent`, and `children`; omitting it preserves the broad compatibility traversal. `mind_context` accepts the same graph control, `include_related: false`, and strict related-parent/tag filters so an assigned task need not pull siblings or globally similar work into its bundle.

## Tool groups

- discovery/read: `mind_list`, `mind_get`, `mind_ready`, `mind_graph`, `mind_discover`, `mind_context`;
- task lifecycle: `mind_claim`, `mind_renew`, `mind_log`, `mind_block`, `mind_resume`, `mind_release`, `mind_finish`;
- correspondence: `mind_ask`, `mind_await`, `mind_message`, `mind_comment`;
- graph/metadata: `mind_create`, `mind_update`, `mind_link`, `mind_unlink`, `mind_archive_created`.

Newly discovered follow-up work can be recorded with `mind_create` and linked to its parent/dependencies. Recorded still does not mean promised; workers must not start unrelated records merely because they exist.
