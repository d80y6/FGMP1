/**
 * Single-flight bookkeeping for `useApi`.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `useApi` de-duplicates concurrent fetches for the same URL so a slow database
 * request is not multiplied by the poll timer and the manual refetch. The
 * original rule was "if an entry with this identity exists, reuse its promise".
 * That rule is wrong for an ABORTED request: the promise can never settle with
 * data, so reusing it means the replacement request is never issued and the
 * loading flag never clears.
 *
 * The dashboard showed exactly that: `/api/fgmp/fuel/runout-eta` and
 * `/api/fgmp/analytics?…&projection=dashboard` were aborted during the
 * mount→cleanup→mount cycle React performs in development, the second mount
 * joined the dead promise, and two widgets stayed in their loading state
 * indefinitely while the endpoints answered 200 to a direct fetch.
 *
 * The rule is therefore: join only a request that is still capable of
 * completing. This file is pure, so the rule is tested without a DOM.
 */

export type InFlightEntry = {
  /** URL + serialized deps of the request this entry represents. */
  identity: string;
  /** The AbortController that owns this request (compared by identity). */
  owner: unknown;
  /** Aborted requests are never joined: their promise cannot deliver data. */
  isAborted: () => boolean;
};

/**
 * Should a caller reuse the entry that is already in flight?
 *
 * `null` (nothing in flight), a different identity (a different URL or deps),
 * or an aborted controller all mean "issue a new request".
 */
export function shouldJoinInFlight(
  entry: InFlightEntry | null | undefined,
  identity: string,
): boolean {
  if (!entry) return false;
  if (entry.identity !== identity) return false;
  return !entry.isAborted();
}

/**
 * Should a cleanup clear the shared slot?
 *
 * Only the request that owns the slot may clear it. A stale cleanup (an effect
 * that has already been replaced) must never discard the entry a newer request
 * has registered, or the newer request would be duplicated.
 */
export function shouldReleaseInFlight(
  entry: InFlightEntry | null | undefined,
  owner: unknown,
): boolean {
  return !!entry && entry.owner === owner;
}
