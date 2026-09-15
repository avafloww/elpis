# Add opt-in Discord feedback controls

Discord guilds can now set `feedback_reactions: true` to add 👍 and 👎 from the bot account to each chunk in a successfully completed agent text send. Channel policy objects may override the guild value with their own boolean, scalar entries inherit it, and threads use their parent policy. Slash-command and ephemeral interaction replies use a separate path and do not receive controls. The default is false, so existing configurations do not gain new outbound effects.

The complete text-chunk loop and any captured speech finish before controls are attempted. Controls are then best-effort: current send authority and mute state are rechecked before each reaction, and a failed reaction cannot invalidate either delivery, abort later text, or invite a duplicate send. Human 👍/👎 verdict capture remains active regardless of the display setting, while the bot's own reactions remain ignored as feedback.

Parser, inheritance, multi-chunk delivery, reaction-failure, authority-expiry, and existing verdict regressions were exercised alongside the Discord/config suites and build. After enabling the setting, verify one real message shows both controls and that tapping either still records feedback.
