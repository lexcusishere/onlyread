# X

Browse timelines, posts, profiles, search and notifications.

Domains: `x.com`, `api.x.com`, `upload.x.com`

## Tested

Reads that work with OnlyRead on:

- Home timeline (For you and Following)
- Explore and trends
- Search (Top and Latest)
- Open a post and its replies
- Profiles, their posts, replies and media
- Notifications
- Bookmarks and History
- Browse the settings pages
- Live like and repost counts

Writes that are refused (implicit ones are writes the page makes on its own):

- Publish a post
- Reply to a post
- Like a post
- Repost a post
- Bookmark a post
- Pin a post to the profile
- Delete a post
- Change an account setting
- Dismiss a new-user prompt (implicit, allowed with read-tracking on)
- Chat (direct messages): the chat channel is a WebSocket, which is refused

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.
The recorded run passed the leak check: no request OnlyRead refused reached the server.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py x`.
