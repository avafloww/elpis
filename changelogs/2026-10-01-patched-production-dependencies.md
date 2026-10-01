# Patch production dependencies

The production dependency overrides now select Hono 4.13.12 and brace-expansion 1.1.21. These releases close the active Hono boundary-rendering advisory and the brace-expansion recursion/expansion denial-of-service advisories while preserving the existing major-version dependency contracts.

No Elpis API or configuration behavior changes.
