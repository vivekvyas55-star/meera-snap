# Play Together connection repair

Fixed shared Supabase receiver ownership: app banners, calls, and game screens now multiplex one subscribed channel per friend. Unmounting one subscriber cannot remove another subscriber's channel. Authenticated peer identity is available to both existing call handlers and game handlers.

Saved invitations no longer close the board on a broadcast timeout. Acceptance is awaited and checked before entering the room. The inviter reconciles acceptance from the existing database record every three seconds. Incoming moves validate sender, room, index, opponent mark, and turn order. Corrected the next-turn message after an opponent move.

Validation: existing 63 tests passed, plus three regression cases covering shared channel lifetime, a broadcast failure after invitation persistence, and rejected acceptance. Lint and production build passed. These are automated mocked-client checks; a physical two-device playthrough has not been performed. Boards still live in client memory and do not survive closing both clients.
