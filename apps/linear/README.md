# Linear

Read issues, projects, cycles and views. Refuses issue, project, comment, reaction and settings mutations.

Domains: `linear.app`

## Tested

Reads that work with OnlyRead on:

- Issue lists, backlog and My issues
- Open an issue
- Projects and project pages
- Views and filters
- Search
- Recently deleted
- Settings pages
- Notification inbox

Writes that are refused (implicit ones are writes the page makes on its own):

- Create an issue
- Edit an issue: status, priority, assignee, labels, due date, title
- Edit a description
- Delete or archive an issue
- Restore from Recently deleted
- Comment, reply, edit or delete a comment
- React with an emoji
- Add an attachment or link
- Favorite
- Create or update a project
- Post a project update
- Create a view
- Create a label
- Typing drafts (implicit)
- View preferences (implicit, allowed with read-tracking on)
- User settings (implicit)
- CSV export (a write like any other mutation)

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py linear`.
