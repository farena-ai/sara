// 3.3.0 (ezplain): why a mailbox sign-in failed, as one of a few plain reasons the setup page explains
// in everyday words (web/mail-accounts.js): the password was wrong, the provider wants 2-step
// verification and an app password, IMAP is switched off in the mailbox's web settings, or the mail
// server can't be reached. The server's own words stay available as details.

export type SignInReason = 'password' | 'two-step' | 'imap-off' | 'unreachable' | 'other';

export function explainSignIn(raw: string, preset = ''): SignInReason {
  const s = String(raw ?? '');
  // Gmail: "Application-specific password required", "534-5.7.9 … log in with your web browser".
  if (/application-specific password|app(lication)? password required|5\.7\.9|web ?browser|web login required|two-step|2-step|second factor/i.test(s)) return 'two-step';
  if (/not enabled for imap|imap (access )?is (disabled|off|not enabled)|enable imap|imap.{0,20}disabled|yet to enable imap|pop3?\/imap|imap access/i.test(s)) return 'imap-off';
  if (/authenticationfailed|authentication failed|invalid credentials|login failed|incorrect (user|password)|username and password not accepted|bad (user|password)|\b535\b|auth(entication)? (error|failure)|wrong password|invalid (login|password)/i.test(s)) return 'password';
  if (/enotfound|eai_again|econnrefused|econnreset|ehostunreach|enetunreach|etimedout|timed? ?out|took too long|could ?n.t (connect|reach)|could(n.t| not) be found|not be reached|no such host|certificate|self.signed/i.test(s)) return 'unreachable';
  // Yahoo and AOL answer a wrong app password with a bare "[AUTHENTICATIONFAILED]"-like line; the
  // presets that always need an app password treat a plain LOGIN refusal as a wrong password.
  if (preset && /\bLOGIN\b.*\b(NO|BAD)\b|\b(NO|BAD)\b.*\bLOGIN\b/.test(s)) return 'password';
  return 'other';
}
