# Facebook

Browse the feed, profiles, pages, groups, search and marketplace. Refuses posts, reactions, comments, saves, edits, deletions and settings changes. Messenger is out of scope.

Domains: `facebook.com`

## Tested

Reads that work with OnlyRead on:

- Home feed and post details
- Own profile and About page
- Search
- Notifications
- Friends, Groups and Events
- Pages (Meta) with posts and photos
- Marketplace
- Saved items
- Settings pages (read)

Writes that are refused (implicit ones are writes the page makes on its own):

- Create a post
- React to a post
- Comment on a post
- Reply to a comment
- Edit a post
- Save a post
- Move a post to trash
- Edit the profile bio
- Change a setting (dark mode)
- Typing indicators and screen-time logging (implicit, allowed with read-tracking on)
- Videos marked watched and stories marked seen (implicit, allowed with read-tracking on)
- Audience-prompt acknowledgements (implicit)

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.
The recorded run passed the leak check: no request OnlyRead refused reached the server.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py facebook`.
