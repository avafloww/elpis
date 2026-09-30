# Dark pending-attempt receipts

Schema 36 adds immutable, content-free receipts for a future dark pending-branch attempt and its recovery abandonment. Database guards bind an attempt to the globally earliest maximal admitted prefix, its exact non-runnable request view, and the active coordinator and continuation lineage.

Attempt branches cannot issue effects, create capsules, or yield. They can crash only after an immutable coordinator-recovery abandonment receipt, and abandonment does not consume the underlying admissions.

This is dormant persistence substrate. No store or runtime path writes either table, queue work is not claimed or assembled, provider execution is unchanged, and the continuation head cannot advance through this feature.
