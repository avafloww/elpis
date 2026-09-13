# Gateway image includes shared console synchronization code

The Gateway image build now copies `src/console/sync.ts`, which its console client imports during type-checking. The source and workspace builds already had access to this file, but the Gateway Dockerfile's narrower build context omitted it and caused release container builds to fail with a missing-module error.

The container contract test now checks both the required shared module and the exact resident-source copy inventory. This change affects only Gateway image assembly; it does not alter the console synchronization behavior itself.
