# LDAP Single Sign-on

Signs Matinee users in against an LDAP directory. Active Directory and FreeIPA are the tested targets, and any directory that answers a bind and a user search works with the same fields.

## What it does

- A directory user who signs in for the first time gets a Matinee account with the default library grants.
- A local account with the same username is linked to its directory identity on that user's first directory sign-in. Its local password stops working from then on.
- Linked accounts cannot change their password in Matinee and cannot request a reset link. Self-registration and password reset are switched off on the whole server while the plugin is enabled.
- Members of the administrator group become Matinee administrators. Leave the group empty to manage the admin flag in Matinee instead.
- The login page keeps a "Sign in with a local Matinee account" switch for accounts that exist only on this server, such as the admin created at setup.

## Setup

1. Install the plugin from the catalog and enable it.
2. Open **Configure** and click **Fill in the Active Directory example** or **Fill in the FreeIPA example**.
3. Replace the host, the base DN, the service account and the administrator group with your own values.
4. Enter the service account password and **Save**.
5. Reopen **Configure** and click **Test connection**. The toast reports how many users the filter matches.
6. Sign in on the login page with a directory username and password.

To stop using the directory, open **Settings -> Users** and click **Detach from directory** on each linked account, setting a local password as you go. Then disable the plugin.

## Fields

| Field | Active Directory | FreeIPA |
|---|---|---|
| Directory URL | `ldaps://dc1.example.com:636` | `ldaps://ipa.example.com:636` |
| Service account DN | `CN=matinee,OU=Service Accounts,DC=example,DC=com` | `uid=matinee,cn=sysaccounts,cn=etc,dc=example,dc=com` |
| User base DN | `DC=example,DC=com` | `cn=users,cn=accounts,dc=example,dc=com` |
| User filter | `(&(objectClass=user)(objectCategory=person)(sAMAccountName={username}))` | `(&(objectClass=posixAccount)(uid={username}))` |
| User DN template | `{username}@example.com` | `uid={username},cn=users,cn=accounts,dc=example,dc=com` |
| Stable id attribute | `objectGUID` | `ipaUniqueID` |
| Username attribute | `sAMAccountName` | `uid` |
| Administrator group DN | `CN=Matinee Admins,OU=Groups,DC=example,DC=com` | `cn=matinee-admins,cn=groups,cn=accounts,dc=example,dc=com` |

`{username}` in the filter stands for the login name with LDAP filter characters escaped. The stable id attribute is what the Matinee account stays linked to, so a rename in the directory keeps the same Matinee account. When the attribute is missing the DN is used instead.

### Without a service account

Leave the service account DN empty and set the user DN template. The plugin then binds as the signing-in user and reads the profile with that user's own permissions. Both directories let a user read their own entry, including `memberOf`. A wrong password and an unknown username look the same to a direct bind, so an unknown name does not fall through to a local account of the same name. Use the local-account switch on the login page for those.

### Certificates

`ldaps://` and StartTLS verify the directory certificate against the CAs the server trusts. Tick **Accept self-signed certificates** for a directory whose certificate is not, which skips verification for this plugin only. The address blocks of the plugin runtime apply to the directory as well, so link-local and cloud metadata addresses are refused.

## Permissions

The plugin requests the `auth` scope to register itself as a sign-in provider and the `ldap` scope to open connections to the directory. It makes no other network requests and stores nothing.
