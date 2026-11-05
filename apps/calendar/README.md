# Google Calendar

Browse calendars, events, search and settings. Refuses event changes, settings, calendar creation and deletion.

Domains: `calendar.google.com`, `calendar-pa.clients6.google.com`, `clients6.google.com`

## Tested

Reads that work with OnlyRead on:

- Day, Week, Month, Year and Schedule views
- Navigate between dates
- Search events
- Open event details
- Browse the settings pages
- View Trash
- View the calendar list

Writes that are refused (implicit ones are writes the page makes on its own):

- Create an event
- Edit an event
- Move an event by dragging
- Delete an event
- Restore an event from Trash
- Create a secondary calendar
- Delete a calendar
- Change a setting
- Show or hide a calendar
- Create a task
- Complete a task
- Dismiss onboarding prompts (implicit, allowed with read-tracking on)
- Persist the view mode on view switch (implicit, allowed with read-tracking on)
- RSVP through an invitation email's Yes/No/Maybe link

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py calendar`.
