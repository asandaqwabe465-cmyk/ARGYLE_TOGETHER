# Receiving computer: the user's own Windows computer

This is preparation for the agreed receiving computer, not approval to export.
The owner still needs to approve the data scope, timing and private receiving
arrangement. Do not upload an actual export, session cookie or secret to a chat.

## Confirm the computer first

Use Windows PowerShell to run this read-only check:

```powershell
wsl --status
```

If WSL is not installed, installation is a separate guided step. Do not begin
the live maintenance window until Ubuntu/WSL and Linux Node >=22.13 are ready
and the synthetic tests pass there. The Windows Node installation is separate
from Node inside Ubuntu. The local cloud tests do not verify this Windows PC.

Use Ubuntu's Linux home directory, such as `/home/your-linux-user/argyle-private`,
for credentials and exports. Avoid `/mnt/c`, OneDrive, shared school folders,
repositories and automatically synchronised directories. The tools enforce
Unix `0700` directory and `0600` file permissions; do not weaken those checks.

Confirm the Windows volume holding Ubuntu's storage has suitable encryption
(Device Encryption or BitLocker, as available). WSL permissions alone do not
encrypt a disk. Establish protection and the recovery-key arrangement before
receiving private records. If protection is uncertain, resolve it first.

## Local readiness checks, using source and synthetic data only

In the complete source checkout in Ubuntu, install its locked dependencies
using the existing project setup instructions, then run:

```sh
node --version
node --test tests/download-export.test.mjs tests/import-rehearsal.test.mjs
```

Do not copy private credentials or data into the checkout. The synthetic tests
use temporary directories, fake users and local storage, not the original Site.
Dependency installation and these tests do not require an export credential,
resident records, the original database password, or Cloudflare API credentials.

## Sign-in and direct private download

Separately, sign into the original app in a browser using the organiser email
configured as `ADMIN_EMAIL`. Confirm the organiser controls are available. This
is the app's sign-in, separate from the ChatGPT account owning the Site.

Before activating maintenance, establish a private way to provide that app's
unexpired `argyle_session` cookie and the temporary export secret to the local
credentials file. Do not use a ChatGPT browser cookie. Do not send either value
through chat, email, GitHub, screenshots or command arguments.

The intended transfer is a direct authenticated HTTPS download from the
original Site into this private Ubuntu directory on the user's computer. This
avoids an intermediate archive shared through chat or public file hosting. TLS
protects transit; private permissions and disk encryption protect the receiver.
The original owner must approve the named recipient and receiving arrangement.
Checksums detect accidental changes; they do not prove ownership or consent.

After approval and a verified pause, use the downloader procedure in
`OWNER-REVIEW.md`. No live download has been carried out as part of preparing
these instructions.

## Rehearse a completed private export locally

The following offline command accepts an existing complete export and creates
a **new local** SQLite restore and photo copy. It never connects to Cloudflare
or imports records into the live destination:

```sh
node migration/rehearse-import.mjs \
  --source https://argyle-walk-together.sweet-cream-7564.chatgpt.site \
  --export /absolute/private/completed-export \
  --output /absolute/private/new-rehearsal-directory
```

It verifies completion/checksums, schema compatibility with the trusted source
migrations, exact row counts, required relationships, photo references/bytes
and empty temporary authentication/notification tables. It preserves message
sequence values. It never executes SQL provided by the export manifest.

Success creates `REHEARSAL.json` last, alongside `restored.sqlite`,
`inventory.json` and photos named by the hash of their exact storage key. These
outputs contain private resident data and need the same protection as the
original export. A failed output directory is incomplete, even if some files
exist. The source must remain unchanged and retained for rollback.

Before a real export, agree on temporary-copy retention and deletion after
acceptance. Actual destination import, private email/notification setup,
acceptance testing and final cutover remain separate steps. An offline
rehearsal does not establish source quiescence or a completed migration.
