# Atomic dark pending assembly

A new store/root API atomically recomputes the earliest dark pending frontier, assembles its bounded non-runnable local request, and records the immutable pending-attempt receipt in one immediate transaction. The caller cannot provide the selected world, events, message projections, renderer, sequence range, manifest, parent, or authority epoch.

Empty or blocked frontiers write nothing. Candidate construction, request-view creation, or attempt rejection rolls back the branch and coordinator reservation. Coordinated recovery now records abandonment before crashing and releasing an attempt branch, leaving the continuation head and admissions unchanged so a fresh branch can retry the same earliest work.

This remains disconnected from live ingress, Agent, provider dispatch, tools, effects, consumption, activation, cache, and compaction. It cannot advance the continuation head or execute the assembled request.
