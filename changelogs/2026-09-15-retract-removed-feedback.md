# Retract removed Discord feedback

Removing a 👍 or 👎 reaction from an Elpis-authored Discord message now retracts the matching stored feedback. Retraction is exact to the Discord message, reactor, and emoji: it does not delete another person's feedback, feedback on another message, or the opposite reaction. Historical duplicate add rows for that exact key are all removed so the stored projection reflects the current reaction state; a repeated removal is an idempotent no-op.

Discord add and remove events for one exact key are serialized in gateway arrival order. This prevents a quick removal from racing ahead of a slower partial-reaction hydration and leaving a stale feedback row. The remove path never fetches the removed reaction itself, which may no longer exist; it hydrates only a partial message when authorship must be verified. Bot-authored control reactions, ignored users, irrelevant emoji, unconfigured guilds, and reactions on non-Elpis messages remain excluded. Feedback capture and retraction do not depend on whether visible feedback controls are enabled.

Store and registered-listener regressions cover exact-key scope, duplicate cleanup, idempotence, hidden controls, removed partial reactions, ignored users, and controlled add/remove ordering without wall-clock sleeps.
