# Admit bounded inbound Signal attachments

Configured Signal direct messages may now carry `signal-cli`-downloaded attachments into the existing inbound attachment envelope and multimodal image path. Attachment captions become message content when the ordinary body is empty.

The transport accepts at most ten attachments of at most 25 MiB each. Child-provided IDs must be safe basenames resolving to regular non-symlink files directly beneath the configured Signal attachment directory. Unknown senders and other unsupported Signal event kinds remain rejected before Agent history, and outbound Signal delivery remains text only.
