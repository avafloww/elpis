# Send bounded local files to configured Signal contacts

Programmatic `elpis.channel("signal:<alias>").send(...)` calls can now attach up to ten local files of at most 25 MiB each while preserving Signal's native text formatting.

Every attachment must use an absolute path to a regular non-symlink file, and the whole set is validated before one `signal-cli` JSON-RPC send. Signal derives the displayed filename from the path basename, so a supplied `name` must match it; custom renaming, reply metadata, and mention options remain unsupported. Exact configured aliases, contact `allow_send`, mute checks, and acceptance-not-delivery receipts are unchanged. Speech headers remain text-only, and no configuration migration is required.

Validation: focused Signal transport and JSON-RPC tests, the deterministic unit suite, and a production build. After restart, verify a fresh PDF or image send to one configured contact and confirm the received filename and bytes.
