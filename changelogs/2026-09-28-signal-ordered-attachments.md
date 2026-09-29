# Preserve every outbound Signal attachment

Signal sends with more than one file now validate the complete set before dispatch, then issue one ordered `signal-cli` request per attachment. The first attachment carries the authored text and native formatting; later attachments are file-only messages.

This avoids a Signal client limitation that can silently retain only one file when a single message mixes attachment types. The existing ten-file and 25 MiB-per-file bounds, basename rules, contact authorization, mute checks, and acceptance-not-delivery receipt remain unchanged. Elpis never automatically replays a failed or partially accepted batch.

Validation: a regression reaches the real Signal transport boundary and proves a mixed PDF/HTML request becomes two ordered one-file daemon sends while invalid later files reject before any new dispatch. The focused Signal suite, deterministic unit suite, and production build passed. After restart, verify one fresh two-file canary; recipient observation is required to establish both files arrived.
