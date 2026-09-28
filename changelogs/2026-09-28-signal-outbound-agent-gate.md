# Signal file sends pass the shared Agent gate

The first outbound-attachment rollout updated the Signal transport, but the shared Agent send policy still rejected every file option before transport dispatch. No Signal request was issued for that rejected attempt.

The Agent gate now forwards file options for configured Signal contacts while retaining the exact alias, `allow_send`, mute, reply, and mention checks. An Agent-level regression test exercises the file option through the shared dispatch seam so transport-only tests cannot miss this boundary again. No configuration migration is required.

Validation: focused Signal tests, the deterministic unit suite, and a production build. After restart, repeat one fresh attachment send and treat only the resulting `signal-cli` acceptance as issued—not as delivery or read.
