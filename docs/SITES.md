# Tested sites: what was tested

Each tested site ships with a profile: the reads below work with OnlyRead on, and the writes below are
refused. The lists come from each site's `apps/<site>/coverage.json`. This file and `apps/<site>/README.md`
are written from it by `harness/site/build_site.py`.

A site's profile counts as tested (its `verified` flag, which nothing in the UI shows: every guarded site is guarded the same way) only when every tested read works with no false blocks, every tested write is
refused, and the refused change is confirmed absent from the server afterwards, not just from the page.
"(implicit)" marks writes the app makes on its own, such as marking a message read when it is opened.

Any other site can be added from the settings page or with **Guard this site** in the popup. It is then
guarded by the rules and the judge alone, without a decoder or reviewed verdicts, so expect some reads to
be refused until they are labeled.

## Gmail

### Reads that work

- Open the inbox and folders: Sent, Starred, Drafts, All mail, Trash
- Open and read a message
- Search mail
- Open an invitation and see its RSVP buttons
- Browse the settings pages
- Autocomplete contacts while composing

### Writes refused

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

## Google Calendar

### Reads that work

- Day, Week, Month, Year and Schedule views
- Navigate between dates
- Search events
- Open event details
- Browse the settings pages
- View Trash
- View the calendar list

### Writes refused

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

## Linear

### Reads that work

- Issue lists, backlog and My issues
- Open an issue
- Projects and project pages
- Views and filters
- Search
- Recently deleted
- Settings pages
- Notification inbox

### Writes refused

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

## LinkedIn

### Reads that work

- Home feed, scrolling and post details
- Own profile and other members' profiles
- Search: all, people and companies
- My Network, Notifications, Messaging inbox, Jobs
- Company and school pages with their posts and comments
- Saved items
- Settings pages (read)
- Record search history (implicit, allowed: it changes nothing you see)
- Realtime push subscription (implicit, allowed: it only opens the update feed)

### Writes refused

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

## Facebook

### Reads that work

- Home feed and post details
- Own profile and About page
- Search
- Notifications
- Friends, Groups and Events
- Pages (Meta) with posts and photos
- Marketplace
- Saved items
- Settings pages (read)

### Writes refused

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

### Out of scope

- Messenger (chats and sending messages): not guarded, so messages are delivered even in enforce

## X

### Reads that work

- Home timeline (For you and Following)
- Explore and trends
- Search (Top and Latest)
- Open a post and its replies
- Profiles, their posts, replies and media
- Notifications
- Bookmarks and History
- Browse the settings pages
- Live like and repost counts

### Writes refused

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

## Telegram

### Reads that work

- Chat list and live updates (incoming messages)
- Open a chat and read its history
- Search (chats, people and messages)
- Bot and contact profiles

### Writes refused

- Send a message
- Reply to a message
- React with an emoji
- Edit a message
- Pin a message
- Delete a message
- Save a draft (implicit)
- Mark as read (implicit, allowed with read-tracking on)

### Not yet tested

- Typing indicator (Telegram Web sent none in a bot chat)
- Channels and groups: joining, posting, settings
- Media and file uploads
- Account and privacy settings

## WhatsApp

### Reads that work

- Chat list and live updates (incoming messages, typing)
- Open a chat and read its history
- Group info
- Search
- Contact lookups and profile pictures

### Writes refused

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
