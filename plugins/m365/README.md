# @justimpactgroup/m365

Microsoft 365 for OpenClaw through Microsoft Graph. This first release signs in to Microsoft 365
and checks the connection. Mail, calendar, contacts, OneDrive and SharePoint tools follow in later
releases.

## Install

```bash
openclaw plugins install clawhub:@justimpactgroup/m365
# or from npm; append @<version> to pin the version you reviewed
openclaw plugins install npm:@justimpactgroup/m365
```

## Register an app in Microsoft Entra

The plugin signs in as a user, through an app registered in your own tenant. It uses no client
secret.

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **App registrations** >
   **New registration**.
2. Supported account types: **Accounts in this organizational directory only** (shown as
   **Single tenant only** in newer versions of the admin center). Select **Register**.
3. Open **Authentication** and add a redirect URI (**Add Redirect URI** or **Add a platform**) for
   the platform **Mobile and desktop applications**, with the custom redirect URI
   `http://localhost/openclaw-m365`.
4. Under **Authentication**, leave **Allow public client flows** at **No**. Add no client secret.
5. Under **API permissions**, keep the delegated Microsoft Graph permission **User.Read**. If users
   in your tenant can't consent to apps, or if you use step 7, select **Grant admin consent** for
   your tenant (needs at least the Cloud Application Administrator role).
6. Copy the **Application (client) ID** and **Directory (tenant) ID** from the **Overview** page.
7. Optional: to limit who can sign in, open the app under **Enterprise applications** >
   **Properties**, set **Assignment required** to **Yes**, and assign the users. Users can then no
   longer consent themselves, so an admin must grant consent as in step 5.

## Configuration

```json5
{
  plugins: {
    entries: {
      "justimpactgroup-m365": {
        enabled: true,
        config: {
          tenantId: "<Directory (tenant) ID>",
          clientId: "<Application (client) ID>",
        },
      },
    },
  },
}
```

Both are IDs, not secrets.

## Sign in

Only the Gateway owner gets the sign-in tools: in the Control UI chat that is an operator with
admin access; in a chat channel it is a sender listed in `commands.ownerAllowFrom` (for example
`telegram:<your user id>`). Being in a channel's `allowFrom` is not enough, and `openclaw doctor`
warns when no owner is set.

Ask the agent to sign in to Microsoft 365:

1. The agent replies with a Microsoft sign-in link. Open it and sign in.
2. The browser then shows an error such as "This site can't be reached". That is expected.
3. Copy the full address from the address bar (it starts with `http://localhost/openclaw-m365?`)
   and paste it into the chat within about a minute.

Start the sign-in only in a direct chat with the agent, not in a group or channel: anyone in your
tenant who sees the link can finish it with their own account. Paste your own address yourself,
and check that the account the agent reports is yours. If it is not, enable
`justimpactgroup_m365_sign_out` (below) and sign out. Step 7 above limits who can finish a
sign-in.

The pasted address passes through the chat and your model provider. The code in it works only
once, expires after about a minute, and is useless without a secret the plugin keeps in memory.

## Tools

| Tool                                    | Description                                                    | Side effects                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `justimpactgroup_m365_status`           | Signed in or not, and as whom (any sender, not only the owner) | Reads your profile (`GET /me`); may store a renewed token, or delete a sign-in Microsoft has expired or revoked |
| `justimpactgroup_m365_sign_in`          | Starts a sign-in (owner only)                                  | None; no network access                                                                                         |
| `justimpactgroup_m365_sign_in_complete` | Finishes a sign-in (owner only)                                | Redeems the code and stores the tokens                                                                          |
| `justimpactgroup_m365_sign_out`         | Signs out (owner only, optional)                               | Deletes the stored tokens. Enable with `tools.alsoAllow`                                                        |

To enable sign-out: `tools.alsoAllow: ["justimpactgroup_m365_sign_out"]`. Without it, sign in
again to renew a sign-in, or revoke access at Microsoft (below).

## Network access

- `login.microsoftonline.com`: `POST /<tenantId>/oauth2/v2.0/token` with the client ID, the scopes
  and either the sign-in code with its PKCE verifier or the refresh token.
- `graph.microsoft.com`: `GET /v1.0/me` with the access token.

Nothing else. Redirects are not followed.

## Stored data

The refresh token, your account's object ID, sign-in name and granted scopes are stored in
OpenClaw's plugin state (`~/.openclaw/state/openclaw.sqlite`). This is **not encrypted at rest**:
only file permissions protect it, as for OpenClaw's own OAuth tokens, and backups include it. Use
full-disk encryption and a dedicated OS user for the Gateway. Access tokens stay in memory.

## Revoking access

`justimpactgroup_m365_sign_out` deletes the tokens on the Gateway only (enable it with
`tools.alsoAllow`, see [Tools](#tools)). To revoke the refresh token at Microsoft, use **Sign out
everywhere** in [My Account](https://myaccount.microsoft.com) or have an admin revoke your sessions.
Removing the app's consent blocks new access tokens only while no consent exists: the stored refresh
token stays valid, and works again if consent is granted again, including tenant-wide admin consent.
So sign out on the Gateway or revoke your sessions as well.

## Limits

- One Microsoft account per Gateway, shared by every agent allowed these tools. Restrict them with
  per-agent tool policy.
- Work or school accounts in the global Microsoft cloud only; no personal accounts or national
  clouds.
- Conditional Access (sign-in frequency, compliant devices, token protection) can block the sign-in
  or ask for a new one.
- The Gateway renews the token about hourly from its own IP, and Conditional Access checks that IP.
  If it is not a trusted location and MFA is required there, complete MFA during sign-in or have an
  admin trust the Gateway's IP.
- After 90 days without use, or after a password reset, sign in again.

## Later releases

Mail, calendar, files and sites need more Graph permissions. With Microsoft's default consent
settings, users cannot consent to `Mail.*`, `Calendars.*`, `Files.Read.All` or `Sites.Read.All`
themselves, so an admin will need to grant consent.

## Security

Runs inside the OpenClaw Gateway without a sandbox; enable only the tools you need. This plugin
sends no telemetry. Report vulnerabilities privately as described in the
[security policy](https://github.com/justimpactgroup/openclaw/blob/main/SECURITY.md).

## License

MIT. Not affiliated with or endorsed by the OpenClaw project.
