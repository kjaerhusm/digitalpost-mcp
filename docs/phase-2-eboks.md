# Phase 2 — private e-Boks

Private e-Boks (“Post fra virksomheder”) is separate from Digital Post. The
letters live at `https://mobile-api-dk.e-boks.com/2`. The tools are off unless
`DIGITALPOST_EBOKS=1`.

## Registration

`digitalpost eboks-register` runs once, after `digitalpost login`:

1. Reuse the Digital Post access token.
2. `POST https://digitalpostproxy.e-boks.dk/loginservice/v2/connect/usertoken`
   with an empty body and `Content-Length: 0`.
3. `POST https://oauth-dk.e-boks.com/1/connect/token` with
   `grant_type=usertoken`, the public mobile client, and this machine's device id.
4. `POST /user/mobileaccess/password/verify` with the mobile-access password.
   The password is not stored and is not written to the log.
5. `PUT /user/current/device` with a generated RSA public key (base64 of the
   DER SubjectPublicKeyInfo, the same shape as chime-mu/ebox).

The device id and the private key are stored encrypted in `eboks-device.enc`
(mode `0600`) in `DIGITALPOST_DIR`. Afterwards the e-Boks token (about five
minutes) is obtained from the Digital Post token plus the device id, without
MitID and without the password.

## Reading

`DIGITALPOST_EBOKS=1` registers metadata tools and two content tools.

Metadata, which does not mark a letter read:

- `eboks.discover`
- `eboks.list_folders`
- `eboks.list_messages`
- `eboks.get_message`

Content, which **does** mark that one letter read. The tool description says
so, the result includes `markedRead: true`, and `readOnlyHint` is false:

- `eboks.get_document` saves one letter body or one attachment
- `eboks.extract_pdf_text` returns the text of that one file

e-Boks marks a message read on
`GET /2/mail/folders/{id}/messages/{id}/content` and
`GET /2/mail/folders/{id}/messages/{id}/attachment/{id}/content`. The guard
allows those two GET shapes and rejects every other `/content` path before a
network call. The tools take one `messageId`. They do not walk a folder.

This program does not send the follow-up `POST` that would set `unread` back
to true, and it does not move, archive, reply, or delete. The mail client
refuses any method other than GET on `/2/mail/...`.

Prefer `eboks.get_message`. Download content only for the letter you mean to
read.

Shared mailboxes, including e-Boks Erhverv after the company has shared it to
you and you have accepted, are listed by `eboks.discover` and selected with
`userId`. A CPR-shaped id is not returned, and a CPR-shaped `userId` (10
digits, or six digits, a dash, and four) is refused before any request. The
profile's CPR is dropped.

## Revoke

Remove the device under *Mobiladgang* on e-boks.dk, and delete
`eboks-device.enc`.

## Not in this phase

mit.dk company post as its own MitID session (distinct from a Digital Post
organisation mailbox and from a shared e-Boks mailbox) is still out of scope.
