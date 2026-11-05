const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function passkey(api, kind) {
  const options = await api(`/passkeys/${kind}/options`, {}); const challenge = options.challenge;
  options.challenge = decode(options.challenge);
  if (options.user) options.user.id = decode(options.user.id);
  for (const field of ['allowCredentials', 'excludeCredentials']) if (options[field]) options[field] = options[field].map(key => ({ ...key, id: decode(key.id) }));
  const credential = kind === 'register' ? await navigator.credentials.create({ publicKey: options }) : await navigator.credentials.get({ publicKey: options });
  if (!credential) throw new Error('Passkey unavailable');
  const response = { id: credential.id };
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) if (credential.response[key]) response[key] = encode(credential.response[key]);
  await api(`/passkeys/${kind}/finish`, { challenge, response });
}
