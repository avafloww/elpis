# Preserve fenced code in Signal formatting

Matched backtick and tilde fenced code blocks now remove their opening fence, optional language/info string, and closing fence while preserving the code body's exact line structure. The whole body receives one native Signal monospace range.

Unclosed fences remain literal instead of partially stripping markers. Inline formatting outside fenced blocks continues normally; headings, blockquotes, and Markdown links remain unsupported literal syntax.
