# Signal replies retain their quoted context

Allowlisted direct messages sent with Signal's native reply gesture now include a bounded shared `<reply-to source="signal-quote">` envelope child. Previously the ordinary message arrived but its quote was discarded, so the resident could not tell which earlier message the sender meant.

Only quotes attributed to the configured contact or the supervised local account are projected. Quoted text is capped at 16 KiB, quoted attachment bodies are not imported, unknown quoted authors are ignored, and the source marker makes clear that the quote is embedded by the current sender rather than independently fetched from an original message.

No configuration migration is required. Validate after restart with a fresh native Signal reply and confirm the resident sees the referenced author and text.

Validation: focused Signal and envelope tests, deterministic unit suite, and production build.
