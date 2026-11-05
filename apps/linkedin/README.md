# LinkedIn

Browse the feed, profiles, search, jobs, messages and notifications. Refuses posts, reactions, comments, saves, follows, profile edits and settings changes.

Domains: `linkedin.com`

## Tested

Reads that work with OnlyRead on:

- Home feed, scrolling and post details
- Own profile and other members' profiles
- Search: all, people and companies
- My Network, Notifications, Messaging inbox, Jobs
- Company and school pages with their posts and comments
- Saved items
- Settings pages (read)
- Record search history (implicit, allowed: it changes nothing you see)
- Realtime push subscription (implicit, allowed: it only opens the update feed)

Writes that are refused (implicit ones are writes the page makes on its own):

- Create a post (the composer opens, Post is refused)
- React to a post
- Comment on a post
- Save a post
- Delete a post
- Edit the profile headline / intro
- Follow a company
- Change a setting
- Mark notifications and invitations seen (implicit, allowed with read-tracking on)
- Messaging read receipts and badge clearing (implicit, allowed with read-tracking on)

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.
The recorded run passed the leak check: no request OnlyRead refused reached the server.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py linkedin`.
