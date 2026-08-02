# Platforms

Torana separates a logical agent from the endpoints where people reach it.
One agent owns one runner policy and any number of Buzz endpoints plus at most
one Telegram endpoint. A Buzz-only agent is valid.

Every endpoint normalizes inbound activity into the same durable event and
conversation model. Core scheduling, sessions, runner dispatch, and outbox
recovery are platform-neutral; adapters own wire authentication, rendering,
capabilities, and remote delivery.

| Capability            | Telegram          | Buzz                                     |
| --------------------- | ----------------- | ---------------------------------------- |
| Messages and replies  | yes               | yes, signed                              |
| Edits                 | streamed replies  | signed native edits                      |
| Deletes and reactions | no durable API    | signed, durable                          |
| Forums and votes      | not enabled       | native                                   |
| Typing and presence   | best effort       | best effort                              |
| Attachments           | Telegram file API | signed same-origin Blossom               |
| Replay cursor         | `update_id`       | `(created_at,event_id)` per subscription |
| Workspace tools       | runner tools      | endpoint-scoped credential broker        |

See [Telegram](platforms/telegram.md), [Buzz](platforms/buzz.md), and
[sessions](sessions.md). The old [transports](transports.md) link remains as a
compatibility pointer.
