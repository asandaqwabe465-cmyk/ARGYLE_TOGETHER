# Temporary Gmail setup for Argyle Together

Sender: **argyletogether@gmail.com**. Organiser: **asandaqwabe465@gmail.com**, unchanged.

This is temporary while the residence assesses the domain request. Only verification codes use Gmail. Volunteer requests remain in the organiser dashboard. Distress alerts remain in the app, with optional Web Push for devices that residents enable. Trip notifications also use Web Push. Gmail is not used for these notifications; distress email stays disabled. See MOBILE-SETUP.md.

## 1. Create the Google script

1. Sign in to https://script.google.com/ with **argyletogether@gmail.com** and choose **New project**.
2. Name the project **Argyle Together verification sender**.
3. Open `Code.gs` in the editor. Replace its starter code with the complete contents of [the prepared Code.gs](integrations/google-apps-script/Code.gs). Save it.
4. Select **setup** in the function dropdown beside Run, then click **Run**. Review Google's permission prompt using the new Gmail account. The script needs permission to send email and identify the account running it; it does not read your inbox. If Google presents a warning you do not understand, stop and share its wording, without codes or credentials.
5. The execution log should say **Setup complete**. Setup does not send an email.

## 2. Deploy the sender

1. Choose **Deploy → New deployment**.
2. Select **Web app** as the deployment type.
3. Set **Execute as: Me (argyletogether@gmail.com)**.
4. Set **Who has access: Anyone**, then deploy. The app server needs to reach this endpoint without a Google login; the script rejects any request that lacks its private cryptographic signature. Keep the signature check in the code.
5. Copy the **Web app URL**, ending in `/exec`. You may send that URL to Codex; it is not the secret. Do not use the `/dev` test URL.

Official deployment instructions: https://developers.google.com/apps-script/guides/web

## 3. Privately connect the secret

1. Open the script's **Project Settings → Script properties**. Find `RELAY_SECRET`, created by setup.
2. In the local SAFETY project's `.env` file, paste that value after `GMAIL_RELAY_SECRET=`. Paste the deployed URL after `GMAIL_RELAY_URL=`. Set `EMAIL_PROVIDER=gmail`.
3. Save the file and tell Codex **“The Gmail values are saved in .env.”** Do not paste the secret in chat, screenshots, the script source, or a public document. This local file is ignored by Git and excluded from the published app.
4. Codex can then transfer the two values to server-side hosting settings and deploy the update. Residents never receive the secret.

## 4. Validate before inviting residents

Sign in to the app as **asandaqwabe465@gmail.com**. Check that the code arrives from the new sender, then test a second resident address. Test volunteer review and an explicitly agreed test distress alert with two connected devices. Local automated tests cannot confirm real Gmail delivery, account restrictions or device behavior.

Personal Google accounts currently have a MailApp allowance of 100 recipient sends per day, shared across scripts on the account. Codes for returning logins and resends also count. Google may change or further restrict quotas. If the quota is exhausted, new codes stop; the app reports this and existing sessions continue. Use this Gmail account only for the app. Quotas: https://developers.google.com/apps-script/guides/services/quotas

## Returning to the original plan

After residence approval and domain verification, configure `RESEND_API_KEY` and `EMAIL_FROM`, change `EMAIL_PROVIDER` to `resend`, and deploy. This restores volunteer approval emails and distress email attempts alongside in-app alerts, without deleting accounts, trips or applications. Provision sufficient email capacity: Resend's free daily allowance cannot email more than 100 residents for one alert. Test delivery and restore pending application notifications through the existing retry action. Disable the Google script deployment and remove the Gmail relay secret after the switch is verified. Residence approval alone does not automatically make this switch.
