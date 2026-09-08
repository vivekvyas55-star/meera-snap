# Meera Play Together: research and implementation direction

Audience: Meera product and engineering. Date: 2026-09-08.

## Scope and direct answer

The strongest model for Meera is a private activity embedded inside the existing pair conversation: one room identity, chat that never forces navigation away from play, durable invitations and responses, and notifications that return a person to the existing room. The current implementation now covers embedded realtime chat, quick social replies, persistent invitations, delayed acceptance, and room restoration. The next engineering priority should be durable board state so a match survives both devices being closed.

## Evidence and implications

Discord describes Activities as multiplayer social experiences embedded directly in DMs or channels, without a separate window or download. Its multiplayer guidance says all participants joining an activity must resolve to the same instance identifier and use that identifier to load shared state. This supports Meera's combined game-and-chat screen and its room UUID design. Sources: [Discord Activities](https://docs.discord.com/developers/platform/activities), [Discord Multiplayer Experience](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience).

Apple's turn-based GameKit guidance treats messages, game data, background notifications, and notification-to-existing-match routing as one lifecycle. Notifications should return a player to the existing match, and reminders are intended for the participant whose turn needs attention. This supports Meera's durable accepted-invite record and suggests that future reminders should be turn-specific rather than generic engagement pushes. Source: [Apple: Sending messages to players in turn-based games](https://developer.apple.com/documentation/gamekit/sending-messages-to-players-in-turn-based-games).

Discord's Rich Presence guidance makes joinability actionable while warning that presence can be publicly exposed. For Meera, the useful pattern is the direct join action; the public presence model conflicts with the product's pair-only privacy goal. Meera should keep activity state visible only to the two participants. Source: [Discord Rich Presence](https://docs.discord.com/developers/platform/rich-presence).

## Implemented from the research

- Game and recent private text chat share one screen.
- Chat is collapsible on small displays and shows an unread count while closed.
- Realtime messages merge into the panel and displayed messages receive normal read handling.
- Quick replies reduce interruption during a move: “Your turn,” “Nice move,” a laugh, and “Good game.”
- Delayed acceptance is durable and restores the original room for the inviter.
- Closed-app acceptance uses a fixed server-controlled notification phrase, without message content.

## Next build priorities

1. Persist board, turn, version, and result in a pair-authorized `game_sessions` table keyed by invitation/room. Apply moves through an atomic RPC to prevent double moves and client tampering.
2. Resume accepted games for either participant after a device restart, not only from the acceptance banner.
3. Send a rate-limited “your turn” notification only when the recipient is inactive, with no board or chat content on the lock screen.
4. Add rematch consent, a small mutually visible match history toggle, and automatic expiry. Default history should remain off.

## Limitations

The current board is synchronized through private realtime broadcasts but is not yet authoritative after both clients close. Browser push availability still depends on notification permission and, on iOS, installation as a Home Screen web app.

## Claim-to-source ledger

- Embedded activity inside social context; Discord, “Activities,” accessed 2026-09-08: https://docs.discord.com/developers/platform/activities
- Shared instance identity and participant lifecycle; Discord, “Multiplayer Experience,” accessed 2026-09-08: https://docs.discord.com/developers/activities/development-guides/multiplayer-experience
- Background turn notifications and return-to-match behavior; Apple, “Sending messages to players in turn-based games,” accessed 2026-09-08: https://developer.apple.com/documentation/gamekit/sending-messages-to-players-in-turn-based-games
- Join actions and privacy implication of presence; Discord, “Rich Presence,” accessed 2026-09-08: https://docs.discord.com/developers/platform/rich-presence
