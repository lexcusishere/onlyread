# Gmail

Read mail, search and open messages. Refuses star, archive, trash, snooze, labels, drafts, send, replies and settings changes.

Domains: `mail.google.com`, `calendar.google.com`

The profile also covers `calendar.google.com`: the Yes, No and Maybe links in an invitation email apply the RSVP there with a plain GET (`/calendar/event?action=RESPOND`), and the rule that refuses it holds only on a guarded domain.

## Tested

Reads that work with OnlyRead on:

- Open the inbox and folders: Sent, Starred, Drafts, All mail, Trash
- Open and read a message
- Search mail
- Open an invitation and see its RSVP buttons
- Browse the settings pages
- Autocomplete contacts while composing

Writes that are refused (implicit ones are writes the page makes on its own):

- Star
- Archive
- Move to Trash
- Snooze
- Report spam
- Create and apply a label
- Mark as read when opening a message (implicit, allowed with read-tracking on)
- Clear the unseen flag on inbox render (implicit, allowed with read-tracking on)
- Compose and save a draft
- Send
- Reply
- Change a setting
- Create a filter
- RSVP to an invitation (card buttons and the Yes/No/Maybe links)

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.
The recorded run passed the leak check: no request OnlyRead refused reached the server.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py gmail`.
