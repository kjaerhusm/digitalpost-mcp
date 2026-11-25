# digitalpost-mcp

An **unofficial personal client** for your own Danish Digital Post and, if you
turn it on, your own e-Boks. It is a local [MCP](https://modelcontextprotocol.io)
server. It is **not** affiliated with Digitaliseringsstyrelsen, mit.dk,
e-Boks, or borger.dk, and it is not an official client of any of them.

You run it on your own machine, for the mailbox you can already open. It does
not send mail, move it, archive it, or delete it.

## Read this before you connect a model

**A cloud LLM client sees the letter contents this server returns.** Subject,
sender, PDF text, and e-Boks body text all go to whatever MCP client you
configured. If that client sends the conversation to a hosted model, the
letter goes there too. Use a client you accept that for. This program does
not log letter text.

mit.dk’s terms prohibit unofficial automated extraction of the mailbox. This
repository is for **personal use by the mailbox owner**, who has accepted
that. Do not point it at anyone else’s mail. Do not host it for other people.

## What it reads

Digital Post (“offentlig post” / “Post fra det offentlige”) is read with
`GET` on `https://gateway.digitalpost.dk/apis/v1`. Those GETs do not change
`read` or `legallyNotified`. A guard rejects any other method to that API
before the request is sent.

Private e-Boks (“Post fra virksomheder”) is off unless `DIGITALPOST_EBOKS=1`.
Listing and opening message metadata do not mark a letter read. **Downloading
the letter or an attachment does.** e-Boks marks that one letter read on
`GET /2/mail/folders/{id}/messages/{id}/content` and
`GET .../attachment/{id}/content`. The two tools that do this say so, return
`markedRead: true`, and are not marked read-only. Every other write (delete,
move, reply, mark-unread) stays blocked. There is no bulk download.

The MitID app login (username, push approval, rotating QR) is the generic
client from [Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp)
(`packages/aula-auth`), MIT licensed, extracted in `packages/mitid`. See
`packages/mitid/NOTICE.md`.

The refresh-token lifetime is not published. An access token lasts about
20 minutes. `digitalpost renew`, or `serve --with-renew`, keeps the refresh
token in use. When the gateway rejects it, the stored login becomes
`login_required` and the refresh token is kept. A timeout or HTTP 5xx does
not delete it and does not flip that flag. Tools then say login is required
until you log in again.

## Tools

Digital Post. None of these mark a letter read.

| Tool | What it does |
| --- | --- |
| `digitalpost.discover` | Login status and mailboxes. Works with no login (it reports that). |
| `digitalpost.status` | Logged-in state, access-token expiry, last successful renew, mailbox list. No tokens. |
| `digitalpost.list_folders` | Folders (`INBOX`, `DRAFTS`, `SENT`, `DELETED`, `USER_DEFINED`). Cached for 60 seconds. |
| `digitalpost.list_messages` | One page. Filters: folder, unread, since, sender, search text, page, size. Returns `nextCursor`. |
| `digitalpost.search_messages` | Across mailboxes or one folder: sender, subject, free text, date range, unread, attachments. |
| `digitalpost.get_message` | Subject, sender, received time, documents. No file bytes. |
| `digitalpost.get_document` | Saves one file under the download directory and returns the path. |
| `digitalpost.extract_pdf_text` | Text of a PDF, so the agent can read the letter. |
| `digitalpost.extract_dates` | Dates, times, and places in one letter, for a calendar check. Heuristics, plus `replyBy` from the gateway. |
| `digitalpost.list_new_since` | Messages at or after a timestamp, with subject date hints. By default at most 3 pages of 100 letters per mailbox (maximum 10). |
| `digitalpost.digest` | New letters grouped by mailbox: sender, subject, received time, unread, detected dates. Up to 3 PDFs. By default scans at most 3 pages of 100 letters per mailbox (maximum 10). |
| `digitalpost.mailbox_summary` | Folder totals (`totalElements`) and sender counts from the newest 100 letters. |

`digitalpost.digest` and `digitalpost.extract_dates` label parsed dates as
heuristics. Confirm them before adding a calendar event. PDF text is read
only from Digital Post, where the file GET does not mark the letter read.

Search sends `sender.label`, `label`, `receivedDateFrom`, `receivedDateTo`,
and `any` when the gateway documents those parameters, then checks the page
locally. Unread and attachments are not query flags on the list API (the
unread-exists endpoint wants a CPR, which this program never sends), so they
are applied to a bounded number of pages: at most 5 pages of 100 per call.
Pass `nextCursor` to continue.

e-Boks, only when `DIGITALPOST_EBOKS=1`. Prefer the metadata tools.

| Tool | Marks read? | What it does |
| --- | --- | --- |
| `eboks.discover` | No | Profile name, folders, shared mailboxes. No CPR. |
| `eboks.list_folders` | No | Folders in your mailbox or a shared one. |
| `eboks.list_messages` | No | One page of message metadata. |
| `eboks.get_message` | No | One message, including attachment names. |
| `eboks.get_document` | **Yes** | Saves one letter or one attachment. Returns `markedRead: true`. |
| `eboks.extract_pdf_text` | **Yes**, if it calls e-Boks | Text of that one letter. A local `path` does not contact e-Boks (`markedRead: false`). |

Organisation mailboxes that the same citizen login can already open are
listed by `discover`. A company e-Boks mailbox appears only after it has been
shared to you and you have accepted. See
[docs/phase-2-eboks.md](docs/phase-2-eboks.md).

## Requirements

- Linux
- Node.js 24 (`.nvmrc` and `engines`). Types and the package manager.
- [Bun](https://bun.sh) 1.4 (the runtime: tests, CLI, MCP). CI uses 1.4.5.
- pnpm 12.21.0 (`packageManager` in `package.json`)

```sh
pnpm install
pnpm test
```

## Login

```sh
pnpm digitalpost login
```

That listens on `http://127.0.0.1:8098/` and nowhere else (8099 is aula-mcp's login port). Enter the MitID
username. Approve the push in the MitID app, or scan the QR codes on the page.
They change while the app is waiting. When the chain finishes, the program
exchanges the `eboksdk://` authorization code for tokens and stores them
encrypted. You do not paste a URL from browser devtools.

The page refuses any `Host` other than loopback, and state-changing requests
must send `X-Digitalpost-Login: 1` so another site cannot submit the form.

If MitID offers more than one identity, pick it on the page, or set
`DIGITALPOST_IDENTITY` to the 1-based index before starting.

## Commands

```sh
pnpm digitalpost whoami          # status and mailboxes, no letter text
pnpm digitalpost status          # expiry, last renew, mailboxes; no secrets
pnpm digitalpost renew           # new access token; exit 2 if login is required
pnpm digitalpost eboks-register  # once: mobile-access password, then the device is stored encrypted
pnpm digitalpost doctor          # paths, permissions, read-only guard, gateway reachability
pnpm digitalpost doctor --probe-login
                                 # also walks the real authorize URL until MitID, then stops
pnpm digitalpost mcp             # Streamable HTTP on 127.0.0.1:8788 (not 7878)
pnpm digitalpost serve --with-renew
                                 # HTTP MCP plus token renew in the same process
pnpm mcp:stdio                   # stdio, for clients that spawn a process
```

`mcp --with-renew` is the same renew loop. `scripts/serve-with-renew.sh`
restarts that process if it exits. The script does not delete tokens.

Equivalent direct entry points:

```sh
bun apps/cli/src/index.ts login
bun apps/cli/src/index.ts serve --with-renew
bun packages/mcp-server/src/server.ts
bun packages/mcp-server/src/server-stdio.ts
```

## MCP configuration

stdio (Cursor, Claude Desktop, and anything that spawns a command):

```json
{
  "mcpServers": {
    "digitalpost": {
      "command": "bun",
      "args": ["/absolute/path/to/digitalpost-mcp/packages/mcp-server/src/server-stdio.ts"],
      "env": {
        "DIGITALPOST_DIR": "/home/you/.config/digitalpost-mcp"
      }
    }
  }
}
```

Streamable HTTP, loopback only. This is the setup used for a morning
overview on `127.0.0.1:8788`:

```json
{
  "mcpServers": {
    "digitalpost": {
      "url": "http://127.0.0.1:8788/mcp"
    }
  }
}
```

Start it with `pnpm digitalpost serve --with-renew` (or `pnpm digitalpost mcp`).
`GET http://127.0.0.1:8788/healthz` lists the tools and does not need a login.
Setting `DIGITALPOST_MCP_HOST` or `DIGITALPOST_LOGIN_HOST` to anything except
`127.0.0.1` or `localhost` makes the process refuse to bind.

## Keeping the login alive

Access tokens last about 20 minutes and are refreshed automatically while a
tool is running. The refresh token’s idle lifetime is unknown.

One process, renewing every 15 minutes (override with
`DIGITALPOST_RENEW_INTERVAL_MS`, minimum 60 seconds):

```sh
scripts/serve-with-renew.sh
```

Or cron, if you would rather not leave the server up:

```cron
15 */6 * * * DIGITALPOST_DIR=$HOME/.config/digitalpost-mcp /absolute/path/to/bun /absolute/path/to/digitalpost-mcp/apps/cli/src/index.ts renew
```

Exit code `0` means the access token was renewed. Exit code `2` means the
stored login was rejected. `digitalpost renew --force` retries a refresh
token that was kept after that rejection. If it still fails, run
`digitalpost login`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DIGITALPOST_DIR` | `~/.config/digitalpost-mcp` | Config directory (mode `0700`). |
| `DIGITALPOST_DOWNLOAD_DIR` | `$DIGITALPOST_DIR/downloads` | Where document tools write files. |
| `DIGITALPOST_MCP_PORT` | `8788` | HTTP MCP port. Not 7878 (that is aula-mcp). |
| `DIGITALPOST_LOGIN_PORT` | `8098` | Login page port. Not 8099 (that is aula-mcp). |
| `DIGITALPOST_KEY` | file `.key` in the config dir | 32-byte hex or base64 AES key. On a shared machine, set this from a password manager or the host secret store instead of leaving the key in the `.key` file. |
| `DIGITALPOST_LOG` | unset | `1` logs to stderr. Tokens are redacted. |
| `DIGITALPOST_LOGIN_TRACE` | unset | `1` writes a redacted hop-by-hop login trace to stderr. |
| `DIGITALPOST_IDENTITY` | unset | 1-based MitID identity when several are offered. |
| `DIGITALPOST_EBOKS` | unset | `1` registers the `eboks.*` tools, including the two that mark a letter read. |
| `DIGITALPOST_RENEW_INTERVAL_MS` | `900000` | How often `serve --with-renew` refreshes the access token. |
| `DIGITALPOST_RESTART_SECONDS` | `5` | How long `scripts/serve-with-renew.sh` waits before starting the process again. |

The mailbox list is cached for 5 minutes and the folder list for 60 seconds.
File bytes are not cached. A new login misses the cache.

## Private e-Boks

After `digitalpost login`, register this machine once:

```sh
pnpm digitalpost eboks-register
```

The command asks for the e-Boks mobile-access password, uses it once, and does not store it. It keeps an encrypted device key at `eboks-device.enc` (mode `0600`) next to the Digital Post tokens. Set `DIGITALPOST_EBOKS=1` on the MCP process to expose the e-Boks tools.

Use `eboks.get_message` first. Call `eboks.get_document` or `eboks.extract_pdf_text` only for the one letter you want to read. That download marks it read. This program will not post a follow-up to mark it unread, move it, or delete it.

A company mailbox (e-Boks Erhverv) appears only after it has been shared to you and you have accepted the share. `eboks.discover` lists those shares. Pass the share's `userId` to the other tools. A CPR-shaped id is refused.

To revoke the device, remove it under *Mobiladgang* on e-boks.dk and delete `eboks-device.enc`.

## Security

- Tokens are AES-256-GCM. The file mode is `0600`. The ciphertext does not
  contain the token strings.
- `id_token` from the token endpoint is discarded. It can carry identity claims.
- Tool output drops `ownerIdentityId` and recipient ids. A 10-digit CPR-shaped
  value is not copied into the public mailbox view.
- Logs go through the vendored redactor (authorization, cookies, tokens,
  `cpr`, `ownerIdentityId`, `recipientId`). Letter bodies are not logged.
- Downloads are confined to the download directory.
- There is no raw-request tool. The only state change this program can make
  to a mailbox is the e-Boks read mark that comes with downloading one letter,
  and only when those two tools are enabled.

To revoke local access, delete the directory. Details, the cloud-client
warning, and how to report a vulnerability in private are in
[SECURITY.md](SECURITY.md).

## Layout

```
packages/mitid          vendored MitID / SRP / PKCE client (MIT, aula-mcp)
packages/digitalpost    OAuth, encrypted tokens, read-only API, login page
packages/mcp-server     stdio and streamable HTTP
apps/cli                login, whoami, status, renew, serve, doctor
scripts/serve-with-renew.sh
```

## Development

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Tests use mocked HTTP and the fixtures in `packages/digitalpost/fixtures`.
They do not contain a real mailbox. `pnpm test` does not log in and does not
call gateway.digitalpost.dk or e-Boks.

## Acknowledgements

- [Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp) — MitID client, MIT.
- [chime-mu/ebox](https://github.com/chime-mu/ebox) — the Digital Post token and
  `GET /apis/v1` calls this program follows, described in `docs/how-it-connects.md`.
- [Hundter/MitID-BrowserClient](https://github.com/Hundter/MitID-BrowserClient)
  — the NemLog-in form the QR flow posts back to (`e-boks.py`).
- The Digital Post OpenAPI published at `test.digitalpost.dk`.
