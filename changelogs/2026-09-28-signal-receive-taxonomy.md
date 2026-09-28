# Signal direct-message metadata no longer drops ordinary text

Signal ingress now admits the sender's ordinary body and attachments when `signal-cli` also supplies link previews, quote context, mention ranges, native text styles, or story context. Previously a link preview caused the whole direct message to disappear.

The receive parser now classifies the complete tested `dataMessage` field set instead of relying on a partial deny-list. Unknown fields, group/effect/control events, positive disappearing-message timers, and view-once content fail closed before attachment hydration or Agent history. Receive notifications must carry the supervised single-account child's E.164 or ACI identifier, and daemon receive errors emit metadata-only diagnostics without exposing error text. Compound envelopes that mix a data message with another top-level event also fail closed.

No configuration migration is required. After restart, verify with a fresh allowlisted direct message containing a URL: its body should arrive once, while preview title, description, and image metadata stay out of the Agent envelope.

Validation: focused Signal tests, the deterministic unit suite, and a production build.
