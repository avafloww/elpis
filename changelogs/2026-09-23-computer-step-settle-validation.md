# Prevalidate desktop step settle delay

`elpis.computer.step()` now validates `settleMs` before holding keys. Previously an invalid delay rejected only after the key effect had been issued, making a failed call unsafe to retry blindly.

No configuration or migration change. This closes one pre-dispatch rejection path; errors after a hold is issued still require observation rather than automatic replay.

Validation: the focused computer suite reproduced two issued key commands before the fix and passed 13/13 afterward. The deterministic unit suite passed 90/90, and `npm run build` passed. After restart, verify service health; no live desktop input was issued for acceptance.
