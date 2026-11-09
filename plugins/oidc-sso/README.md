# OpenID Connect Single Sign-on

Signs Matinee users in through an OpenID Connect provider. Keycloak, Authentik, Authelia, Zitadel and Microsoft Entra ID all speak the authorization code flow the plugin uses.

## What it does

- The login page gains a "Sign in with ..." button that sends the browser to the provider and back.
- A user who signs in for the first time gets a Matinee account with the default library grants.
- A local account with the same username is never taken over on its own, so a username chosen at the provider cannot claim an existing Matinee account. To move a local user to the provider, open **Server settings -> Users and access**, expand the account and click **Link to directory**. The next sign-in of that username through the provider keeps the account with its history.
- Linked accounts cannot change their password in Matinee and cannot request a reset link. Self-registration and password reset are switched off on the whole server while the plugin is enabled.
- Members of the administrator group become Matinee administrators, and every other user loses the administrator flag on sign-in, though the last administrator is never demoted. Leave the group empty to manage the admin flag in Matinee instead.
- The password form stays on the login page for accounts that exist only on this server, such as the admin created at setup.

## Setup

1. Install the plugin from the catalog under **Server settings -> Plugins**. The install also enables it.
2. Open **Configure**, enter the issuer URL, and click **Check issuer**. The notice shows the redirect URI to register, `<public API URL>/plugins/oidc-sso/callback`.
3. At the provider, create a confidential web client with that redirect URI and copy its client ID and secret into the plugin. Each field saves when you leave it.
4. Set the administrator group if the provider puts group names into a claim, and add `groups` to the scopes when the provider needs it.
5. Sign in from the login page.

The redirect URI is built from the public API URL under **Server settings -> General -> Public addresses**. Without one, the server builds it from the request and takes `X-Forwarded-Host` and `X-Forwarded-Proto` only from a reverse proxy listed in `TRUSTED_PROXIES`, so set the public API URL whenever the browser reaches Matinee through a proxy. Set the public web URL as well when the web app is served from a different origin than the API.

To stop using the provider, detach each linked account and then disable the plugin:

1. Open **Server settings -> Users and access** and expand the linked account.
2. Enter a new local password of at least 8 characters in the password field.
3. Click **Detach from directory** and confirm.
4. Repeat for every linked account, then click **Disable** on the plugin under **Server settings -> Plugins**.

## Fields

| Field | Default | Notes |
|---|---|---|
| Name shown on the login button | the plugin name | The login page shows "Sign in with" followed by this name |
| Issuer URL | | `https://auth.example.com/realms/home` for Keycloak, `https://auth.example.com/application/o/matinee/` for Authentik, `https://login.microsoftonline.com/<tenant>/v2.0` for Entra ID |
| Client ID | | Required |
| Client secret | | Required |
| Scopes | `openid profile email` | Add `groups` when the administrator group is set and the provider needs the scope |
| Username claim | `preferred_username` | Entra ID sends the login name in `preferred_username` as well |
| Email claim | `email` | |
| Groups claim | `groups` | A list claim with group names, or a single name |
| Administrator group | | Compared exactly against the entries of the groups claim |
| Accept self-signed certificates | off | Skips certificate verification for every request to the provider. Only for a provider whose certificate is not signed by a CA this server trusts |

## How the sign-in is verified

The server exchanges the code for tokens straight at the token endpoint named by the discovery document, with the client secret, over TLS when the issuer is an https URL. That exchange is what vouches for the ID token, so the plugin does not verify its signature, and **Accept self-signed certificates** takes the certificate check out of it. The plugin does check the issuer, the audience and the expiry, and it merges the claims of the userinfo endpoint over those of the ID token when the provider offers one.

Each sign-in carries three random values from `matinee.crypto.randomToken`:

- A state, single-use and valid for ten minutes. It is also kept in the `mtp_oidc-sso_state` cookie of the browser that started the sign-in, so a callback link opened in another browser is refused.
- A PKCE verifier, whose S256 challenge goes to the provider and which the code exchange sends back.
- A nonce, which the ID token must carry.

## Permissions

The plugin requests the `auth` scope to register itself as a sign-in provider, the `network` scope for the provider's endpoints, and the `storage` scope for the state, PKCE verifier and nonce of sign-ins in progress, at most 50 at a time. It stores no tokens.
