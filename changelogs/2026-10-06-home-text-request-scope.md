# Kept every graph request event inside the home text route

Schema v52 adds a database guard requiring every message in a fresh isolated-provider request to come from direct, unforwarded, attachment-free Discord text in the exact scoped guild and channel. The typed store performs the same check, including stored payload integrity, before any provider effect can be prepared.

The migration creates no authority row and does not activate the graph, call a provider, send speech, create capsules, or advance continuation. Existing consumed attempts remain historical no-replay evidence.
