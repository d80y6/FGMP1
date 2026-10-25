/**
 * The rule behind the role-change announcement in `app-shell.tsx` (D-09).
 *
 * Kept as a pure function because the alternative is testing it through a
 * rendered shell, and the shell cannot render without a session, a store and a
 * socket. The behaviour worth pinning is small and entirely here:
 *
 *   - the FIRST role we ever see is the sign-in, not a change → stay silent;
 *   - the same role seen twice is not a change → stay silent;
 *   - anything else is a change → announce once, then remember it.
 *
 * `previous === null` is the sentinel for "no identity resolved yet". It is
 * deliberately not `""`: an empty string is a role value in no code path, but a
 * truthiness bug around it is exactly the kind of thing this function prevents.
 */

export interface RoleAnnouncementState {
  /** The role last seen, or null before the first resolution. */
  previous: string | null;
  /** True when this call produced a change that must be announced. */
  changed: boolean;
}

export function nextRoleAnnouncement(
  previous: string | null,
  role: string | null | undefined,
): RoleAnnouncementState {
  // No identity yet (signed out, or the store has not resolved `me`). Keep the
  // remembered role: a transient null should not turn the next poll into a
  // "change" back to the role the user already had.
  if (!role) return { previous, changed: false };
  if (previous === role) return { previous, changed: false };
  return { previous: role, changed: previous !== null };
}
