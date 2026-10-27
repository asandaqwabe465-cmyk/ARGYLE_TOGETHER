# Argyle Together privacy and operations review

Review date: 11 October 2026. Organiser: Asanda Qwabe. Public privacy/support contact: argyletogether@gmail.com (confirmed by organiser).

## Decision and scope

The residence declined use of its domain. Argyle Together remains an independently operated student initiative. Neither a different domain nor this review establishes POPIA compliance. Do not describe the app as an official residence/security service. Residence security participation has not been confirmed; individual app approval is not evidence of employment, vetting or a service agreement.

This is a source and configuration-declaration review, with isolated functional tests. It is not a penetration test, legal opinion, provider-contract review, inspection of the production database, or verification of actual responder availability. No residents were contacted and no existing production records were deleted in this update.

## Implemented in this update

- Public /privacy page, linked before email collection and throughout the app, identifying the independent organiser and contact.
- Explicit profile privacy acknowledgement checked by the server, with notice version and timestamp stored. Existing accounts are not backdated; they receive a reminder. Existing emergency access is not blocked while they review the notice.
- Authenticated privacy-request form, available even to unfinished accounts. A resident sees only their own requests; the organiser can review the inbox. Request type, details, status and dates are saved. Marking reviewed does not assert completion and does not delete data.
- Clear limitations: no automatic account deletion; broad retention gaps; unverified storage jurisdictions and provider terms; no guaranteed security response.
- Removal of wording that implies residence security will accept requests. Volunteer approvals now remind the organiser to confirm participation and explain the role.

## Data inventory

| Records | Purpose and access | Storage and current retention |
|---|---|---|
| Email, name, phone, profile status | Email sign-in, identification and coordination. Own account; volunteer applications accessible to organiser. Escort phone shared with that trip owner; panic sender phone shared with completed accounts. | D1 users. No age-based deletion. |
| Profile pictures | Recognition. Readable by signed-in completed accounts (or self before profile completion). | R2 profiles/user ID; replacement overwrites the app key. Server does not strip image metadata. Provider version/backup retention unverified. |
| Verification challenges | Email verification. Server-side digest and salt; raw code sent by email. | D1 challenges; valid 10 minutes, max five code checks per challenge. Expired rows cleaned on trip-board fetch. Copies in email/provider systems are separate. |
| Sessions | Authenticated access using HttpOnly Secure SameSite=Strict cookie and server-side digest. | D1; seven-day expiry. Logout removes the user's sessions. Expired-row cleanup is request-triggered. |
| Rate limits | Reduce spam and brute force; account keys and HMAC-derived email/IP keys. | D1 limits; expires by window, cleaned on trip-board fetch. Some keys contain account IDs. |
| Trips and replies | Routes, dates, notes, meeting points and participation. Upcoming trips visible to completed accounts; reply and history permissions checked server-side. | D1; no age-based deletion. Closing a trip does not erase it. |
| Escort assignments | Accepted escort gets trip/chat membership. | D1; retained in trip history. Approval revocation does not erase historical assignments or independently allowlisted roles. |
| Chat messages | Owner, pending applicants, accepted partners and assigned escort; declined applicants lose access. | D1; no end-to-end encryption or age-based deletion. Closed chats read-only. |
| Walk coordinates | Only the latest point per sharing user; fresh points accessible to accepted active-trip members. | D1 locations; hidden after two minutes, request-triggered stale cleanup. Stop sharing, logout and trip closure remove applicable records. No timer guarantee. |
| Panic alerts | Name, photo, phone and available location shared with completed accounts. | D1; coordinates cleared on resolution or fetch-triggered expiry after 24 hours. Other alert records retained. Last-known location can be used. |
| Safety reports and flags | Reports visible to completed accounts, reporter omitted from community response. Organiser sees reporter and private flags/snapshots. Free text can identify people. | D1 incidents and incident_flags; no age-based deletion. Withdrawal/removal hides reports without erasing them or snapshots. |
| Volunteer applications | Reason, account details and approval/review metadata; organiser-only review. | D1 volunteers; retained without age limit. |
| Push subscriptions | Device endpoint, subscription keys and notification choices. | D1; removed on logout/unsubscribe or detected expiry. No automatic age limit. Browser/provider processing is separate. |
| Push attempts | Queue status, attempt count, links to trip/alert/device. | D1 push_deliveries; no general age-based deletion; retries have a bounded delivery window. |
| Privacy acknowledgement | Record of the notice acknowledged when profile is saved; not a legal-compliance determination. | D1 users privacy_version/privacy_accepted. Existing accounts start with null values. |
| Privacy requests | Access, correction, deletion or concern; own history and organiser inbox. | D1 privacy_requests; manual review, no age-based deletion. Not an automatic account-deletion job. |

## External processing and unknowns

Hosting declarations and Sites documentation identify Cloudflare Workers (execution), D1 (structured data) and R2 (photos), operated through OpenAI Sites. They do not prove a South African storage region or establish legal roles/agreements. Confirm controller/responsible-party and operator arrangements, subprocessors, international-transfer terms, backup deletion, administrative access, incident contacts and export/migration options with providers.

The reviewed app source sends sign-in codes and recipient email addresses to the configured Google Apps Script relay, which uses Gmail. In the temporary Gmail mode, volunteer and panic emails are disabled. The retained Resend path can send additional information if enabled in future; do not switch providers without updating the notice and reviewing the terms. Browser push services process device delivery data. Google Maps receives coordinates only when a Maps link is opened. The reviewed app has no AI inference call processing resident trips or chats; this does not settle provider use of logs or other platform data.

## Access-control findings

The server checks app sessions and profile completion, uses same-origin validation for POST requests, keeps credential keys server-side, restricts organiser operations, limits OTP attempts, and applies no-store to API responses/photos. Existing tests exercise role boundaries, private trip chat, coordinates, photo authentication, private flags and escort assignment. New tests cover privacy acknowledgement and privacy-request isolation, including unauthenticated access, CSRF, cross-user review and unfinished accounts.

Material limits remain:

1. The shared invitation code has been distributed in a guide. Possession plus email verification does not prove residence membership. A membership-verification process is still needed before treating the community as restricted to residents.
2. The app intentionally broadcasts panic identity/location to completed accounts and allows pending trip applicants to read chat. Users must understand these audiences; reassess them if membership cannot be verified.
3. Photos can contain embedded GPS/EXIF metadata. Existing uploaded files have not been inspected. Server-side image re-encoding and a plan for existing files are recommended before broader promotion.
4. The operator can technically access stored data. Administrative access, staff confidentiality, secure devices, account recovery and access logs need operational controls.
5. A provider security review, independent application security assessment, backup/restore test and incident-response rehearsal are outstanding.
6. Session/API tests are not proof that every attack is prevented. No assertion of POPIA certification or guaranteed security is made.

## Retention and deletion plan requiring decisions

No bulk deletion was introduced because the purpose, required periods and handling of shared records have not been agreed. The existing behaviour is disclosed rather than claiming that old records expire automatically.

Prepare a justified schedule for each inventory category, addressing inactive accounts, ended trips and chat, expired panic records, reports and moderation evidence, notification records and fulfilled privacy requests. Define exceptions for an actual legal obligation or dispute; do not use indefinite retention as the default. Choose periods only after considering purpose and obtaining suitable advice. Then implement a bounded scheduled cleanup, backup handling, deletion verification and tests.

A deletion implementation must cover D1 relations, R2 objects, sessions, device subscriptions, queued notifications and provider-held data. Shared trips/chat/report evidence require an explicit decision about erasure versus de-identification and third-party rights. Foreign-key ordering and failure recovery must be tested before production use. No deletion should report success until the chosen operations actually finish; document what persists in backups and recipients' copies.

## Request handling procedure

1. Check /privacy#requests while signed in as the organiser, and the support mailbox regularly. In-app requests are saved; this inbox currently sends no automatic email notification.
2. Verify identity using the authenticated request/account email. Never ask for an OTP or password. Ask only for additional evidence necessary to resolve a genuine mismatch.
3. Record the request ID, scope, acknowledgement, actions and outcome in restricted operating records. Do not export another person's data as part of an access request.
4. For correction, residents can update their own basic profile; address other records case by case. For deletion, arrange the reviewed technical procedure described above. Do not imply the request button has erased data.
5. Explain any justified retention or technical limitation and confirm the outcome to the requester. Mark reviewed only after inspecting it; the UI intentionally does not label that status as fulfilled.
6. Track requests through completion and agree a response standard; obtain advice on applicable legal requirements rather than promising an arbitrary legal deadline.

## Responder participation before wider promotion

Ask each volunteer whether they agree to the role, when they are available, how to contact them, what information they may access, and how to withdraw. Explain that app approval is not a background check. Record agreement separately and grant only needed access. Ask residence management for a written arrangement before presenting anyone as acting on behalf of residence security. No app code can confirm this agreement. The organiser has not yet supplied a responder confirmation in this review.

## Provider enquiry checklist

Request written answers from OpenAI Sites/hosting support and the email provider covering:

- Contracting entities, data-processing terms, legal roles and subprocessor list.
- D1/R2, email, log and backup countries/regions; controls for cross-border transfers.
- Encryption/access controls, administrative access logging and security incident reporting channels.
- Retention, export, deletion, restore and termination behaviour, including backups and support copies.
- Whether independent operators can obtain appropriate agreements and meet their obligations for this use case.

This is a preparation checklist. No provider has been contacted by the assistant in this task.

## Regulatory references and outstanding review

The Information Regulator describes security safeguards as technical and organisational measures requiring continuing risk assessment. Its POPIA resources, retention/notification provisions and Information Officer guidance should inform a qualified review of lawful grounds, minimisation, children/special personal information (including incident allegations), access/correction/deletion, operator agreements, transfers, PAIA/Information Officer requirements where applicable, and security-compromise notification. Consent wording alone is not enough.

- Information Regulator POPIA resources: https://inforegulator.org.za/popia/
- Conditions for lawful processing: https://inforegulator.org.za/knowledge-base/category/popia/chapter-3-conditions-for-lawful-processing/
- Information Officer portal guidance: https://inforegulator.org.za/portal-posts/
- Regulator services and security-compromise reporting: https://eservices.inforegulator.org.za/services.aspx

The implementation improves disclosure and gives residents a request channel. It does not close the operational and legal gaps listed here; resolve these before representing the app as assessed or compliant or expanding its use.
