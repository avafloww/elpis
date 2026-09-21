# Expose exact-window desktop cleanup

The resident prompt now advertises the existing `elpis.computer.closeWindow(id)` capability and recommends it for exact-window lifecycle cleanup instead of generic keyboard input.

This changes no desktop implementation, configuration, or migration. It makes the narrower existing capability discoverable so recovery work does not needlessly widen input authority.

Validated with the focused modular-prompt test, the deterministic unit suite, and a production build.
