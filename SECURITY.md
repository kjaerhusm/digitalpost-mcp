# Security

This program stores a Digital Post refresh token that can read the mailbox
until it stops working. Treat the config directory like a password.

- Default path: `~/.config/digitalpost-mcp` (override with `DIGITALPOST_DIR`).
- `tokens.enc` is AES-256-GCM. The key is `DIGITALPOST_KEY` (32-byte hex or
  base64) or a mode `0600` file `.key` created on first use.
- The directory is created mode `0700`. The token file and downloads are `0600`.
- `eboks-device.enc` (mode `0600`) is the encrypted e-Boks device id and private
  key written by `digitalpost eboks-register`. Deleting the config directory
  removes it. Also remove the device under *Mobiladgang* on e-boks.dk.
- The HTTP MCP server and the login page bind to `127.0.0.1` only. Any other
  host is refused.
- Logs redact tokens, authorization headers, cookies, and CPR-shaped fields.
  Letter text is not logged.
- Tool results omit `ownerIdentityId` and recipient identity numbers.
- Downloads cannot be written outside `DIGITALPOST_DOWNLOAD_DIR`.
- Digital Post is read with GET only. Those requests do not mark a letter read.
- e-Boks metadata is also GET only. `eboks.get_document` and
  `eboks.extract_pdf_text` are the exception: e-Boks marks that one letter
  read when its content is downloaded. They are off unless
  `DIGITALPOST_EBOKS=1`. Delete, move, reply, and mark-unread stay blocked.
- Tool results are returned to the MCP client. A cloud-hosted model client
  therefore sees letter text. Letter text is not written to this program's log.

## Revoke

Delete the config directory:

```sh
rm -rf "${DIGITALPOST_DIR:-$HOME/.config/digitalpost-mcp}"
```

That removes the only copy of the refresh token this program keeps. A new
`digitalpost login` creates a new one. It is not documented whether the
gateway invalidates the previous refresh token when you log in again; deleting
the local file is the revocation this program can guarantee.

The OAuth client id in the source is the public e-Boks app client. It is not
your login. Rotating it is not something an end user can do.

## Report a vulnerability

Report a security problem privately through GitHub private vulnerability
reporting:

https://github.com/kjaerhusm/digitalpost-mcp/security/advisories/new

Do not open a public issue for a token leak, a CPR leak, a guard bypass, or
anything else that would put a mailbox at risk. Describe the command and a
redacted line. Do not paste a token, a CPR, or the text of a letter.
