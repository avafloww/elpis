# Discord mention notifications are opt-in

Elpis now separates clickable Discord user-mention markup from notification permission. Every outbound Discord chunk explicitly disables automatic user, role, everyone, and reply-author mention parsing. Only literal user IDs present in that chunk and enabled for the fetched guild may notify; missing settings or lookup failures degrade to no notification.

Core migration `0027-discord-person-settings` adds a typed guild+user preference with an absent/default false value. The resident can inspect or change it through `elpis.personSettings.discord.get(guildId, userId)` and `.set(guildId, userId, boolean)`; there is no per-send override. This setting does not supersede no-contact or do-not-address boundaries.

Focused persistence, sandbox, outbound-policy, reply, and real Discord adapter tests pass, including cross-guild isolation and store-failure fallback. After deployment, verify the service migrates cleanly and an ordinary clickable mention remains silent until its exact guild+user setting is enabled.
