# Activate Argyle Together email

**Temporary Gmail pilot:** follow [GMAIL-SETUP.md](GMAIL-SETUP.md) while waiting for residence approval. The Resend/domain instructions below remain the original plan for the later switch.

The app needs a verified sending domain and a Resend sending key before residents can sign in. The organiser receives applications at **asandaqwabe465@gmail.com**. That address is a recipient and administrator identity; it is not the app's sending address.

1. Obtain permission to use a subdomain of the residence's existing domain, or register a domain you choose. The hosted `chatgpt.site` address cannot be verified as your own sending domain. No domain purchase has been made.
2. Create your own account at https://resend.com/signup. Keep account passwords and verification codes private.
3. In https://resend.com/domains add a sending subdomain such as `mail.YOUR-DOMAIN`. Copy the exact DNS records Resend supplies into your domain provider's DNS settings, then select Verify. Do not replace existing records for the residence's normal email service. Wait for the sending domain to show Verified.
4. At https://resend.com/api-keys create a key restricted to Sending access for that domain. Store it using the site's server-side secret settings as `RESEND_API_KEY`, never in chat, browser code, Git, or a public document. Set `EMAIL_FROM` to `Argyle Together <notifications@mail.YOUR-DOMAIN>` using the verified domain. If using local `.env` for a secure configuration handoff, tell Codex when those two values have been saved; do not paste them in chat.
5. Deploy a saved version to apply the runtime environment changes. Verify a real code reaches the organiser's inbox, then test a second resident account. Provider acceptance alone does not prove inbox delivery.
6. Sign in as **asandaqwabe465@gmail.com**. This designated organiser email can register without a residence invitation code, but must verify its email and complete its profile. Open **Volunteer approvals → Residence invitation code** and share that code privately with residents.
7. Register a test resident with the volunteer checkbox selected. Confirm an approval request arrives in the organiser's inbox. Follow its link, sign in as the organiser, and explicitly approve the application. The resident then gains the **Escort requests** tab. Merely opening the email link never approves anyone.

The Resend testing sender only sends to the email belonging to your Resend account. It cannot support general resident registration. References: https://resend.com/docs/dashboard/domains/introduction and https://resend.com/docs/knowledge-base/403-error-resend-dev-domain

## Operations

Volunteer requests are saved before sending the approval email. If sending fails, the applicant sees a warning and can retry from My profile; the organiser can already review the saved request in the app. The app records provider acceptance, not inbox delivery. Approval and removal of volunteer access take effect in server permissions immediately. The applicant's open screen refreshes on the next board poll.

Security staff can use the same application process, or the operator can configure their verified account emails in the server-only `ESCORT_EMAILS` allowlist. Nobody may assign themselves security or volunteer privileges. Removing volunteer approval does not remove privileges separately granted by that security allowlist.

Panic alerts use in-app polling, optional Web Push, and email attempts when Resend is enabled. There is no SMS, guaranteed background location, or automatic dispatch. See MOBILE-SETUP.md for push limitations. Email failures are reported, but there is no durable panic-email retry queue. Test with consenting residents and the residence's response team before a pilot.
