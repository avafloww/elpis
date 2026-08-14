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

MCP sessions use random in-memory IDs. Clients should terminate sessions explicitly; abandoned sessions are reaped after six idle hours and all sessions disappear on restart. Request bodies are limited to 1 MiB.

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

MCP is an adapter over the same `MindService` used by `elpis.mind`, `/mind`, reminders, and the console dashboard. There is no second task database.

The exposed tools are:

- `mind_list`, `mind_get`, `mind_ready`, `mind_graph`;
- `mind_create`, `mind_update`, `mind_comment`;
- `mind_link`, `mind_unlink`;
- `mind_message`.

Mutations are attributed from MCP initialization metadata as `mcp:<sanitized-client-name>`. Callers cannot choose their own audit actor.

`mind_comment` records work without waking the resident agent. `mind_message` adds a comment and wakes the resident agent with the item and comment IDs. The agent replies as another comment on the same item; the coding agent polls `mind_get`. This gives collaborators a durable return path without exposing the private conversation transcript or impersonating the operator.

External clients are bounded collaborators, not parallel instances of the resident agent. They should read an item before changing it, keep decisions/results/blockers/omissions in comments, and treat recorded ideas or questions as possibilities rather than automatic commitments.
