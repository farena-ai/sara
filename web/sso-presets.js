// V0.8: OpenID Connect provider presets shared by Settings (every server) and business company
// sign-in: the issuer pattern to fill in and the few steps at the provider. Product names stay as they
// are in every language; `t` is the caller's translator, so the texts are extracted from here.
export const SSO_PRESET_IDS = ['authentik', 'keycloak', 'pocketid', 'authelia', 'google', 'entra', 'okta', 'generic'];

const NAMES = { entra: 'Microsoft Entra ID', okta: 'Okta', google: 'Google', authentik: 'authentik', keycloak: 'Keycloak', pocketid: 'Pocket ID', authelia: 'Authelia' };
export const SSO_ISSUERS = {
  entra: 'https://login.microsoftonline.com/TENANT-ID/v2.0',
  okta: 'https://YOUR-ORG.okta.com',
  google: 'https://accounts.google.com',
  authentik: 'https://AUTHENTIK-HOST/application/o/SLUG/',
  keycloak: 'https://HOST/realms/REALM',
  pocketid: 'https://POCKET-ID-HOST',
  authelia: 'https://AUTH-HOST',
  generic: 'https://HOST',
};

/** The provider's display name (`generic` is translated). */
export const ssoPresetName = (id, t) => NAMES[id] ?? t('Other OpenID Connect provider');

/** Steps per provider: [text, issuer pattern shown as code?]. `home` = personal/household servers. */
export function ssoSteps(id, t) {
  const issuer = SSO_ISSUERS[id];
  switch (id) {
    case 'entra': return [
      [t('In the Microsoft Entra admin center open App registrations, choose New registration, pick the Web platform and paste the redirect URL above.')],
      [t('Copy the Application (client) ID. Under Certificates & secrets create a client secret and copy its value.')],
      [t('Issuer URL, with the Directory (tenant) ID from Overview:'), issuer],
      [t('Optional groups: in Token configuration add a groups claim. Entra sends group object IDs; paste those IDs below.')],
    ];
    case 'google': return [
      [t('In Google Cloud Console open Google Auth Platform, then Clients, then Create client. Choose Web application and add the redirect URL above under Authorized redirect URIs.')],
      [t('Copy the client ID and client secret. Issuer URL:'), issuer],
      [t('Under Audience keep the app in Testing and add each person’s Google address as a test user. Google sends no groups: match people by email.')],
    ];
    case 'okta': return [
      [t('In the Okta Admin Console open Applications, choose Create App Integration, then OIDC and Web Application.')],
      [t('Add the redirect URL above as a sign-in redirect URI, tick Refresh Token, and assign the people or groups who may use Sara.')],
      [t('Copy the client ID and client secret. Issuer URL:'), issuer],
      [t('Optional groups: on the Sign On tab set a groups claim filter for the ID token.')],
    ];
    case 'authentik': return [
      [t('In authentik open Applications, then Providers, and create an OAuth2/OpenID provider (confidential). Paste the redirect URL above as a strict redirect URI.')],
      [t('Create an application that uses this provider and note its slug. Copy the client ID and client secret.')],
      [t('Issuer URL, with your application’s slug:'), issuer],
      [t('Groups arrive in the groups claim. Bind the application to the groups who may use Sara.')],
    ];
    case 'keycloak': return [
      [t('In the Keycloak admin console pick your realm, open Clients and create an OpenID Connect client with Client authentication on.')],
      [t('Add the redirect URL above to Valid redirect URIs, then copy the client secret from the Credentials tab.')],
      [t('Keycloak issuer URL:'), issuer],
      [t('For groups add a Group Membership mapper (claim name groups, full group path off) to the client’s dedicated scope.')],
    ];
    case 'pocketid': return [
      [t('In Pocket ID open Administration, then OIDC Clients, and add a client with the redirect URL above as its callback URL.')],
      [t('Leave Public client off, then copy the client ID and client secret.')],
      [t('Issuer URL (your Pocket ID address):'), issuer],
      [t('For groups, create user groups in Pocket ID and allow them for this client.')],
    ];
    case 'authelia': return [
      [t('In Authelia’s configuration add a client under identity_providers.oidc.clients with the redirect URL above in redirect_uris and the scopes openid, email, profile and groups.')],
      [t('Give it a client_id and a hashed client_secret; keep the plain secret for Sara. Restart Authelia.')],
      [t('Issuer URL (your Authelia address):'), issuer],
    ];
    default: return [
      [t('Create a confidential OpenID Connect client (authorization code flow) with the redirect URL above, then copy its client ID and secret.')],
      [t('Issuer URL: the address that serves /.well-known/openid-configuration, without that part.'), issuer],
      [t('For roles add a groups claim to the ID token.')],
    ];
  }
}
