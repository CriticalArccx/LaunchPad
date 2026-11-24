# Supabase email templates

LaunchPad's sign-up, reset and invite emails are Supabase Auth emails. Their
text lives in the Supabase dashboard, not in this repo, so this file is the
copy to paste there.

## Why the links look like this

Supabase's default links go straight to Supabase's verify address, and the
first visit to that address uses the link up. Company email security (for
example Microsoft Defender Safe Links) opens links in incoming mail to check
them, so people clicked a link that had already been used and got "expired".

These templates link to LaunchPad itself with `token_hash` and `type` in the
address. LaunchPad shows a button ("Verify my email", "Set a new PIN" or
"Continue"), and the link is only used when the person taps it
(`showEmailLinkConfirm()` and `confirmEmailLink()` in index.html). A scanner
that opens the link just loads that page.

The links use `{{ .SiteURL }}`, so Authentication → URL Configuration →
Site URL must be the production address, `https://www.launchpad.criticalarccx.com`.

Links in emails sent before the templates change still work the old way.

## Where to paste

Supabase → Authentication → Emails → Templates. For each template below, set
the Subject, switch the body to the source view, replace everything with the
body here, and save.

## Confirm signup

Subject: `Verify your email for LaunchPad`

```html
<h2>Verify your email for LaunchPad</h2>
<p>Someone created a LaunchPad account with this email address. If it was you, tap the button to verify your email:</p>
<p><a href="{{ .SiteURL }}?token_hash={{ .TokenHash }}&type=email" style="display:inline-block;background:#2f7a31;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Verify my email</a></p>
<p>LaunchPad will open and ask you to tap "Verify my email" once more. That's expected.</p>
<p>If you didn't create a LaunchPad account, you can ignore this email.</p>
```

## Reset password

Subject: `Set a new LaunchPad PIN`

```html
<h2>Set a new LaunchPad PIN</h2>
<p>We received a request to set a new PIN for your LaunchPad account. Tap the button to choose a new one:</p>
<p><a href="{{ .SiteURL }}?token_hash={{ .TokenHash }}&type=recovery" style="display:inline-block;background:#2f7a31;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Set a new PIN</a></p>
<p>LaunchPad will open and ask you to tap "Set a new PIN" once more. That's expected. Setting a new PIN also verifies your email.</p>
<p>This link works once and expires after an hour. If you asked more than once, use the newest email. If you didn't ask for this, you can ignore it.</p>
```

## Magic link (used for admin invites)

Subject: `You've been invited to LaunchPad`

```html
<h2>You've been invited to LaunchPad</h2>
<p>You've been given access to a project in LaunchPad. Tap the button to finish setting up your account:</p>
<p><a href="{{ .SiteURL }}?token_hash={{ .TokenHash }}&type=email" style="display:inline-block;background:#2f7a31;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Continue to LaunchPad</a></p>
<p>LaunchPad will open and ask you to tap "Verify my email" once more, then to enter your name and create a PIN.</p>
```

## Checking it worked

Use "Forgot PIN?" on your own account and open the email. The button's link
should start with `https://www.launchpad.criticalarccx.com?token_hash=`.
Opening it should show "Set a new PIN" with a button, and nothing should
happen until you tap it.
