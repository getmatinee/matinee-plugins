# OpenID Connect Single Sign-on

Signs Matinee users in through an OpenID Connect provider. Keycloak, Authentik, Authelia, Zitadel and Microsoft Entra ID all speak the authorization code flow the plugin uses.

## What it does

- The login page gains a "Sign in with ..." button that sends the browser to the provider and back.
- A user who signs in for the first time gets a Matinee account with the default library grants.
- A local account with the same username is linked to its provider identity on that user's first sign-in. Its local password stops working from then on.
- Linked accounts cannot change their password in Matinee and cannot request a reset link. Self-registration and password reset are switched off on the whole server while the plugin is enabled.
- Members of the administrator group become Matinee administrators. Leave the group empty to manage the admin flag in Matinee instead.
- The password form stays on the login page for accounts that exist only on this server, such as the admin created at setup.

## Setup

1. Install the plugin from the catalog and enable it.
2. Open **Configure**, enter the issuer URL, and click **Check issuer**. The toast shows the redirect URI to register.
3. At the provider, create a confidential web client with that redirect URI and copy its client id and secret into the plugin.
4. Set the administrator group if the provider puts group names into a claim, and add `groups` to the scopes when the provider needs it.
5. **Save**, then sign in from the login page.

The server needs a public API URL, or a reverse proxy that sets the forwarded host headers, so the redirect URI the plugin registers is the one the browser reaches. Set the public web URL as well when the web app is served from a different origin than the API.

To stop using the provider, open **Settings -> Users** and click **Detach from directory** on each linked account, setting a local password as you go. Then disable the plugin.

## Fields

| Field | Default | Notes |
|---|---|---|
| Issuer URL | | `https://auth.example.com/realms/home` for Keycloak, `https://auth.example.com/application/o/matinee/` for Authentik, `https://login.microsoftonline.com/<tenant>/v2.0` for Entra ID |
| Scopes | `openid profile email` | Add `groups` when the administrator group is set and the provider needs the scope |
| Username claim | `preferred_username` | Entra ID sends the login name in `preferred_username` as well |
| Email claim | `email` | |
| Groups claim | `groups` | A list claim with group names |
| Administrator group | | Compared against the entries of the groups claim |

## How the sign-in is verified

The code is exchanged for tokens by the server over TLS, with the client secret, straight at the token endpoint. That exchange is what vouches for the id token, so the plugin does not verify its signature. It does check the issuer, the audience and the expiry, and it reads the userinfo endpoint when the provider offers one. Each sign-in carries a single-use state that expires after ten minutes and is also kept in a cookie of the browser that started it, so a callback link opened in another browser is refused. The code exchange uses PKCE with S256, and the id token must carry the nonce of the sign-in that asked for it.

## Permissions

The plugin requests the `auth` scope to register itself as a sign-in provider, the `network` scope for the provider's endpoints, and the `storage` scope for the state, PKCE verifier and nonce of sign-ins in progress. It stores no tokens.
