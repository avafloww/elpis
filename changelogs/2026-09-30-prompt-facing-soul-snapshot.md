# Exact prompt-facing SOUL snapshot primitive

Elpis now has a strict source reader for a future resident identity-authorization handshake. It opens one non-symlink regular `SOUL.md` descriptor, requires a bounded stable UTF-8 read, reuses the existing byte-preserving frontmatter parser, and returns separate exact hashes and byte lengths for the complete source file and the prompt-facing body.

The reader fails closed on missing, changing, oversized, invalid, or empty-body sources. It is not wired into Agent, sandbox tools, persistence, profiles, provider requests, effects, or activation and grants no authority by itself.

Focused tests exercise production reads for exact CRLF/body preservation, BOM-equivalent prompt semantics, frontmatter exclusion, source/body hashes, nonblocking FIFO rejection, and rejection of missing, non-regular, symlinked, empty, invalid-UTF-8, and oversized files.
