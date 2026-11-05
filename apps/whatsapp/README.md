# WhatsApp

Read chats, groups and contacts. Refuses sending, media, reactions, edits, pins, deletes, chat settings and group changes.

Domains: `web.whatsapp.com`

## Tested

Reads that work with OnlyRead on:

- Chat list and live updates (incoming messages, typing)
- Open a chat and read its history
- Group info
- Search
- Contact lookups and profile pictures

Writes that are refused (implicit ones are writes the page makes on its own):

- Send a message
- Send a photo
- Start a voice call (the other phone does not ring)
- React with an emoji
- Edit a message
- Pin a message
- Star a message
- Delete for everyone
- Change a group's description
- Typing indicator (implicit, allowed with read-tracking on)

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.
The recorded run passed the leak check: no request OnlyRead refused reached the server.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py whatsapp`.
