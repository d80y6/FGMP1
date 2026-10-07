/**
 * Notification dispatch — the only place a Notification row's delivery status is
 * decided.
 *
 * ── WHY THE STATUS IS WRITTEN HERE AND NOT BY THE CALLER ─────────────────────
 * If the queueing code chose the status, the two states that matter would be
 * indistinguishable: a row written as SENT at QUEUE time is exactly the "reports
 * success for an action that did not happen" defect. So this module is the sole
 * writer of `status`, and it writes what `dispatch()` reported — nothing else.
 *
 * Every write goes through `withTenant`, because Notification is RLS-protected
 * with FORCE: a bare `db.notification.create()` fails with "new row violates row
 * level security policy", which is the same failure that silently disabled the
 * engine's control-event writes in Phase 2.
 */

import { withTenant } from "./tenant-context";
import { dispatch, type Channel } from "./notification-transport";

/** Maps a transport outcome onto the NotificationStatus enum member. */
export type PersistedStatus = "SENT" | "FAILED" | "NO_TRANSPORT" | "QUEUED";

export type DispatchInput = {
  tenantId: string;
  channel: Channel;
  recipient: string;
  subject: string;
  body: string;
  alarmId?: string;
};

export type DispatchResult = {
  notificationId: string;
  /** The status actually persisted. */
  status: PersistedStatus;
  /** Retained so an operator can diagnose a failure without guessing. */
  reason: string | null;
  provider: string;
  attempts: number;
};

/**
 * Deliver one notification, or record precisely why it was not delivered.
 *
 * The row is created FIRST with the outcome already known, so there is no window
 * in which a queued row implies a pending send that nobody is performing. There
 * is no background worker draining a QUEUED queue in this platform — inventing
 * one that never ran would recreate the same defect.
 */
export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  const outcome = await dispatch(input.channel, {
    to: input.recipient,
    subject: input.subject,
    body: input.body,
    reference: input.alarmId,
  });

  // Translate the transport verdict into the persisted status. Note the
  // one-to-one mapping: nothing here can upgrade a failure into a success.
  const status: PersistedStatus =
    outcome.status === "SENT" ? "SENT" : outcome.status === "FAILED" ? "FAILED" : "NO_TRANSPORT";

  // NO_TRANSPORT and FAILED both retain a reason; SENT records the provider so a
  // later audit can show which transport actually accepted the message.
  const reason = outcome.status === "SENT" ? null : outcome.reason;

  const row = await withTenant(input.tenantId, async (tx) => {
    const created = await tx.notification.create({
      data: {
        tenantId: input.tenantId,
        channel: input.channel as never,
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        alarmId: input.alarmId ?? null,
        status: status as never,
        attempts: 1,
        // sentAt is set ONLY on a real acceptance. A row with a sentAt but no
        // delivery is the exact artifact this design exists to prevent.
        sentAt: outcome.status === "SENT" ? new Date() : null,
      },
      select: { id: true },
    });
    return created;
  });

  return {
    notificationId: row.id,
    status,
    reason,
    provider: outcome.provider,
    attempts: 1,
  };
}