# Telegram

Read chats, search and profiles. Refuses sending, replies, reactions, edits, pins, deletes and drafts.

Domains: `web.telegram.org`

## Tested

Reads that work with OnlyRead on:

- Chat list and live updates (incoming messages)
- Open a chat and read its history
- Search (chats, people and messages)
- Bot and contact profiles

Writes that are refused (implicit ones are writes the page makes on its own):

- Send a message
- Reply to a message
- React with an emoji
- Edit a message
- Pin a message
- Delete a message
- Save a draft (implicit)
- Mark as read (implicit, allowed with read-tracking on)

## How it was verified

Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was
attempted, refused, and checked against the server's own view after a reload: none of them persisted.
The recorded run passed the leak check: no request OnlyRead refused reached the server.

Each write was also checked on another device signed in to the same account, which shows only what Telegram's
servers kept.

## What the page shows

A refused message or reply stays in the chat marked as not sent. A refused edit leaves the editor open, and a
refused pin or delete changes nothing. A refused reaction stays on the message in that browser, even after a
reload, because Telegram Web keeps its own copy of the chat. No other device sees it.

## How it works

Telegram Web does not fit the rest of OnlyRead's design, so it has its own guard. All of its traffic with the
server is MTProto: binary requests, encrypted in the page and sent over one socket, or posted to `/apiw1` when
the socket is not available. Nothing on the network says which request reads and which one writes, so the
network rules and the judge have nothing to decide on. The guard works inside the page instead, on each request
before it is encrypted.

**Where the guard sits.** Telegram's protocol worker (`index.worker`) passes every outgoing request, still
readable, to its crypto worker twice over a MessagePort:
1. `sha256` over part of the auth key and the request, which makes the request's key,
2. `aes-encrypt`.

The guard wraps `postMessage` in the page and in every worker of the tab. It holds each crypto task until it has
read the request (`extension/src/inpage/telegram-worker.ts`).

**Reading a request.** The guard names each call from Telegram's own schema, which it reads from the worker's
script, so a new method is named as soon as Telegram ships it. It opens containers, `gzip_packed` and the wrappers
(`invokeWithLayer`, `invokeAfterMsg`, `initConnection`), and labels every call a read or a write
(`extension/src/inpage/mtproto.ts`). A method the schema does not name counts as a write. Signing this browser in or
out is a read (the code, a QR or other login on this device, the log-out). Creating an account, approving another
device's QR login, ending other sessions and recovering the password are writes.

**Refusing a write.** At the key step, each message in the request that makes a write is replaced, in place and
at the same length, by a method no server knows. The server answers that message with an error, and the reads in
the same request still go through. The encryption then takes the same rewritten bytes, so the key still matches.
A request is refused whole when the guard cannot read it, or when a write is first seen at encryption, because
its key was already made from the original. Then the crypto task is answered with an error and nothing is sent.

**Only what the client sends.** The same `sha256` also hashes every message from the server and the key exchange.
Rewriting one of those would break the session, so the guard touches only a request the client is sending now:
- a message id divisible by 4 (server message ids are odd),
- a time in the id within a day of this computer's clock,
- a length and padding that MTProto allows.

Random data never passes that test, and neither do server messages.

**Getting the guard into every worker.** Each worker of the tab is held as it starts:
- If the page fetched the worker's script itself, the guard is put before the script's first line.
- If the script came from Telegram's service worker or from a `blob:` URL, the worker gets the guard through its
  debugger session once it runs.

The guard is never put into a script that a service worker fetches. Telegram's service worker keeps a copy of
every script it fetches, and a stored guard would outlive its settings.

Until every worker reports that it carries the guard, the tab's socket and its `/apiw1` posts are refused, and
Telegram sends them again. These refusals are logged as `socket-guard-starting` and are not shown as refused
writes.

**SharedWorker.** Chrome's rules do not see a SharedWorker's socket, and no tab's session holds a SharedWorker.
When the page has no `SharedWorker`, Telegram falls back to dedicated workers, so a guarded page does not get one.
A SharedWorker started before protection was switched on is closed, and its tab reloaded.

**Switching off.** The guard cannot be taken back out of a running page. Switching Telegram or protection off
reloads Telegram's open tabs, so the page starts again without it.

The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in
`labels.jsonl`): `python3 harness/site/build_site.py telegram`.
