# Patched transitive proxy address parsing

A production override now pins `proxy-addr` 2.0.8 for the MCP SDK's Express dependency, closing the upstream IPv4-mapped IPv6 trust-subnet spoofing advisory.

No proxy-trust configuration or runtime authority changed.
