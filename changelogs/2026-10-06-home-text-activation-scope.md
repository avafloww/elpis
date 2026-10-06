# Bound fresh graph execution to one home text route

Schema v51 adds an empty-by-default immutable activation scope for the first text-only context-graph cutover. Before any fresh provider attempt can run, the scope must bind the next activation epoch to one exact Discord guild world, guild, channel, and a visible-output cap no larger than one message.

The migration creates no authority row and does not activate the graph, call a provider, send speech, create capsules, or advance continuation. Existing consumed schema-v50 attempts remain readable. Production-function and migration tests cover changed, wrong-world, wrong-channel, and oversized authority plus exact replay.
