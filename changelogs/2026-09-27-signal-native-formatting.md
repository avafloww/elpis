# Render native Signal text styles

Outbound Signal text now converts a bounded inline Markdown subset into native Signal style ranges before calling `signal-cli`: bold, italic, strikethrough, inline monospace, and spoilers. The visible wire text has formatting markers removed while unsupported constructs remain literal.

Ranges use UTF-16 offsets, matching Signal's body-range contract. The client validates every range before dispatch, and more than 128 ranges falls back to the original unmodified text. Delivery receipts still mean accepted by `signal-cli`, not delivered or read; outbound files, replies, and mentions remain unsupported.
