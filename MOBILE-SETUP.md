# Argyle Together on phones

This release is an installable web app (PWA), using the same website, accounts and database. It is not an App Store or Google Play listing.

Open **Install & notifications** in the dashboard. Android residents can use Chrome's Install app / Add to Home screen option. On iPhone (iOS 16.4+ for push), open the link in Safari, choose Share → Add to Home Screen, then open the installed app. Sign in and complete the profile, choose distress and/or trip notifications, and tap Enable notifications. Permission is requested only after this tap. Use Send me a test to check that this device receives a notification; it creates no alert and contacts no other resident.

New trip notifications go to opted-in completed accounts other than the trip author. Tapping opens that trip after sign-in. Distress notifications go to opted-in completed accounts including the sender. Test notifications have a distinct message. The lock screen contains no resident name, phone, photo, destination or coordinates. Details require authentication in the app. Preferences are per device. Turning notifications off removes that subscription; signing out removes every subscription for the account, matching the app's existing all-session logout behavior. Re-enabling is explicit. Up to five devices can be registered per account.

## Runtime configuration

The production environment stores `VAPID_PRIVATE_KEY` as a secret P-256 private JWK JSON object, `VAPID_PUBLIC_KEY` as its base64url uncompressed public point, and `VAPID_SUBJECT` as `mailto:argyletogether@gmail.com`. These were generated for this app; never put the private value in browser code or source. The `web-push` library prepares encrypted aes128gcm requests, delivered through bounded fetch calls. Provider endpoints are restricted to supported Google, Mozilla and Apple push services, with redirects disabled. Gmail quotas are unaffected.

Keep the signing keys stable across deployments. Changing the public key requires residents to disable and re-enable notifications. A future residence-domain move also requires installation and notification permission on the new origin. Changing email from Gmail to Resend is independent and preserves push configuration.

## Delivery limits and operation

Notifications are best effort, not a confirmation of receipt, reading, response or dispatch. Browser permissions, Focus/Do Not Disturb, battery restrictions, internet connectivity and operating-system behavior can delay or block them. Installation does not enable continuous background location: residents must keep the app open and connected for location updates.

Each event/device pair is queued once in D1. Background work begins when a trip or alert is posted; authenticated alert polling resumes unfinished work, including interrupted enqueue operations. Distress deliveries take priority. Requests time out after four seconds; transient errors receive at most three attempts, with 30 seconds between attempts. Each invocation processes up to 100 entries within a 20-second work window. Pending events expire after ten minutes, closed alerts and cancelled/departed trips are skipped, and push service TTL is 60 seconds. Expired subscriptions (404/410) are removed. Queue rows are cleaned up after one day when processing runs. Concurrent workers use leases; a worker interruption after provider acceptance can still cause a duplicate notification. Stable notification tags replace duplicate displays.

There is no independent scheduled queue consumer: retries require app activity. HTTP acceptance is not device delivery confirmation. Existing in-app alerts continue to poll every ten seconds. Test delivery on consenting Android and iPhone devices before inviting residents to rely on it. Test notifications must never be replaced with an unannounced real panic alert.

Only a generic offline page and an app icon are service-worker cached. No accounts, trips, safety reports, photos or coordinates are cached for offline use. Offline requests are not queued, and the app does not claim an alert was sent while offline.

Test notifications use a 30-second per-account cooldown, displayed in the phone controls; failed tests do not accumulate a ten-minute lockout. Test requests allow ten seconds for the push service. Provider status and controlled error categories are logged without subscription tokens, resident information or signing keys.
