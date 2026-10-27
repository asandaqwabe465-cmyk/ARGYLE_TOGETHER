# Argyle Together

## Community safety reports

New safety reports publish immediately to signed-in residents and are labelled **Unverified community report**. Authors may correct or withdraw their own open reports; corrections show a timestamp. Residents may flag other published reports with a reason and optional details. Flags remain private to the organiser, preserve the reported text for review, and do not automatically hide a report. The organiser can remove or resolve reports and mark flags reviewed. Removed, resolved or withdrawn reports cannot be republished through editing. Existing pending reports keep their original visibility until the organiser explicitly publishes them. Reporter account details remain absent from community responses, but free text is not automatically redacted. Limits: five new reports, twenty corrections and ten flag attempts per account per day, with one flag per person per report. Reports must concern incidents within the past 30 days. Reporting and moderation require an open, connected app and do not dispatch assistance. Records and flag snapshots remain stored after removal; removal is not a deletion workflow.

The temporary no-domain pilot is described in [GMAIL-SETUP.md](GMAIL-SETUP.md). Set `EMAIL_PROVIDER=gmail` with a signed Google Apps Script relay to send verification codes only. In that mode, volunteer approval emails and panic emails are deliberately disabled; both features remain available in the app. Set the provider back to `resend` after the residence domain and sending capacity are configured to restore the original email behavior below.

A mobile-friendly residence walking app. Sample trips are separate, temporary preview data. Real accounts and trips use D1; profile pictures use private R2 storage.

See [EMAIL-SETUP.md](EMAIL-SETUP.md) for the organiser's email setup and volunteer approval walkthrough. Registration includes an optional volunteer application. Applications remain pending until the designated organiser signs in and explicitly approves them.

## Before inviting residents

Configure these server-only environment values through Sites (or `.env` for local development):

- `AUTH_SECRET`: at least 32 randomly generated characters. Used to HMAC verification codes and session tokens.
- `RESEND_API_KEY`: an email sending API key from your own Resend account.
- `EMAIL_FROM`: a sender on a domain verified with Resend.
- `RESIDENCE_INVITE_CODE`: a long random invitation code shared directly with verified Argyle House residents. Email verification alone does not establish residence membership. Rotate this code if it is exposed.
- `ESCORT_EMAILS`: optional comma-separated verified account emails of residence security. Approved volunteer accounts also gain escort access through the organiser's review screen. Escorts must keep the app open to see new requests; escort-request notifications are not included; there is no SMS or automatic dispatch.
- `ADMIN_EMAIL`: organiser account, configured as `asandaqwabe465@gmail.com`. This account still requires email verification, but may register without the invitation code. Only this account can review volunteers or retrieve the invitation code in the app.
- `APP_ORIGIN`: the deployed HTTPS app URL used in approval emails.

No provider keys or invitation code are included in source. Accounts fail closed until email and account settings are configured. Requests for escorts are unavailable until security accounts or approved volunteers exist. Public hosting exposes the sign-in page and sample walkthrough; resident data still requires an authenticated, complete account.

## Account and trip behavior

Email sign-up/login uses a six-digit, single-use code, valid for 10 minutes, with five guesses per challenge and request rate limits. Codes are never returned by the API. Sessions use Secure, HttpOnly, SameSite=Strict cookies. Writes check Origin. Production requires HTTPS.

A profile requires a photo, name, cell phone number and location permission. Phone numbers are collected but are not OTP-verified. Profile photos are visible to signed-in residents; phone numbers and email addresses are not listed on the trip board. Residence invitation codes are a small-pilot admission control, not identity checks. The organiser must check residents and approve escorts separately.

Trips are visible to signed-in residents with complete profiles. Replies include meeting points. Trip owners explicitly accept partners. Escorts are requested only after 20 minutes with no replies; this is enforced in the database as well as the UI. A pending request is not a confirmed escort. Only configured escorts can accept requests. Owners start and finish/cancel trips.

Location sharing is opt-in for each active trip after compulsory permission during onboarding. It is limited to accepted trip participants and the assigned escort. Only the latest coordinate is stored. The API hides coordinates after two minutes; cleanup deletes stale locations during board refresh and on trip completion/logout. Coordinates are not visible on the public or residence board. If no requests occur, physical cleanup happens on the next board read. Finished trips clear their coordinates immediately. Visits to external map links disclose those coordinates to the map provider.

Browsers cannot guarantee uninterrupted background GPS. Keep the app open and check timestamps; this is not a native background-tracking app or an emergency response system. Permission can be revoked by the device owner. Test on actual phones before a resident pilot.

## Local development and verification

Use Node >=22.13, `npm run install:ci`, then `npm run db:generate` if changing the schema. Apply generated migrations to local D1 using Wrangler before testing real accounts. Run `npm run dev` for the local web server and `npm run build` for Worker output. `node --experimental-strip-types --test tests/policy.test.ts` verifies timer and coordinate boundary rules. The integration test runs the real handlers against isolated SQLite with D1/R2 adapters and a mocked email transport; never enable a fixed verification code in the deployed app.

Email delivery and real-device geolocation need end-to-end validation after the provider is connected. Before a pilot, establish who watches the escort queue, response hours, fallback contact details, resident verification, data retention/deletion procedures, and privacy notice with the residence organiser. Do not represent this app as guaranteeing safety.

API references: https://resend.com/docs/api-reference/emails/send-email and https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition

## Panic alerts

The panic button opens a clear send action to avoid accidental broadcasts. Sending posts a distress alert for every signed-in resident with a completed account and attempts an individual email to every completed account through Resend batch email (including the sender). Addresses are never exposed to other recipients. The alert contains the resident name, cell number, profile picture in the app, and current coordinates where available. If GPS fails, it sends without coordinates or with clearly timestamped last-known coordinates; location failure does not prevent asking for help. The app polls alerts every 10 seconds while open. The sender can share further location updates while the page stays open and can close the alert. Only the sender can update or resolve it. Closing clears its stored coordinates; already sent emails cannot be recalled.

The email count means the provider accepted the request, not that each resident received or read it. Optional Web Push is available for distress alerts and new trips; see MOBILE-SETUP.md. There is no SMS, automatic emergency-service dispatch or guaranteed background alert delivery. Test email delivery and real phones before relying on it. If an email batch fails, the alert stays visible in the app; the UI must not report that every resident was notified. Active alerts stop appearing after 24 hours. Web Push has a durable queue with bounded retries triggered by app activity, not a continuously running worker. Email has no retry queue, and neither channel has device delivery receipts.

## Trip chat, profile viewing and history

Profile photos on trip cards, owner details, join requests, messages and history can be opened at a larger size. Image requests remain authenticated and are not cached by the service worker.

Trip conversations are shared with the owner, pending applicants, accepted partners and the assigned escort. Declined applicants cannot read or send messages. Existing meeting-point replies retain their original visibility. Messages are plain text, limited to 1,500 characters and 30 new messages per resident per minute. Message IDs make retries idempotent. The open conversation polls every five seconds; it does not add background message notifications. Older messages can be loaded. Closed or expired trip conversations are read-only.

Trip history is private to people who owned, requested to join or were assigned to the trip. Only accepted participants see the companion roster. Completed walks, cancellations and past plans are labelled separately; rosters describe accepted arrangements rather than verified attendance. Closed escort assignments remain part of history. History includes trips when they leave the live board (open plans one hour after departure; active walks four hours after departure), and closed trips immediately. No past live coordinates are exposed in history.

Accepting an escort request immediately joins that account to the walk, My trips, conversation, and active-walk location permissions without a separate join request. Trip details display an assigned escort profile card; the owner can open the photo, name, role and phone number. Other residents do not receive the escort phone number. Location sharing still requires the escort to enable it.

## Independent operation and privacy review (11 October 2026)

The app is independently operated by Asanda Qwabe, with argyletogether@gmail.com as the privacy/support contact. `/privacy` describes current processing and unresolved retention/provider issues. Read `docs/PRIVACY-REVIEW.md` for the inventory and operational work still required. This is not a POPIA certification.

Privacy requests are saved for manual review at `/privacy#requests`. Residents see their own records; the organiser sees the inbox. Profile completion requires explicit acknowledgement of the current notice, recorded with version and timestamp. Existing accounts are not backfilled. Marking a request reviewed does not delete an account or certify fulfilment. The inbox does not send email notifications. No general retention purge or automated account deletion was added.
