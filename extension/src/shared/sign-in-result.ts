// How a Pro sign-in ended, carried in the address of the page that started it (cloud-session.ts startSignIn): the
// background sends the tab back with `?signin=ok`, or `?signin=failed&reason=…`, and the page reads it once.
const KEY = 'signin';
const REASON = 'reason';

/** `url` without any earlier result. */
export function signInBack(url: string): string {
  const u = new URL(url);
  u.searchParams.delete(KEY);
  u.searchParams.delete(REASON);
  return u.toString();
}

/** `back` carrying the result: ok when there is no error. */
export function withSignInResult(back: string, error?: string): string {
  const u = new URL(signInBack(back));
  u.searchParams.set(KEY, error ? 'failed' : 'ok');
  if (error) u.searchParams.set(REASON, error.slice(0, 200));
  return u.toString();
}

/** The result in this page's address, if any, removed from it so a reload doesn't show it again. */
export function takeSignInResult(): { ok: boolean; reason?: string } | undefined {
  const v = new URL(location.href).searchParams.get(KEY);
  if (!v) return undefined;
  const reason = new URL(location.href).searchParams.get(REASON) ?? undefined;
  history.replaceState(null, '', signInBack(location.href));
  return v === 'ok' ? { ok: true } : { ok: false, reason };
}
