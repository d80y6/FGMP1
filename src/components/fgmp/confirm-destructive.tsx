"use client";

/**
 * A single reusable destructive-confirmation dialog (Phase 5, task 4).
 *
 * WHY THIS EXISTS
 * ---------------
 * Seven destructive actions used `window.confirm`. A native dialog cannot be
 * styled, does not render the app's RTL direction correctly for the Arabic UI,
 * has no focus trap an operator can rely on, blocks the main thread, and cannot
 * express a consequence. It is also invisible to the design system.
 *
 * This component replaces all seven with one implementation so the affordances
 * are identical everywhere and there is a single place to check them.
 *
 * SAFETY PROPERTIES, DELIBERATE:
 *   - CANCEL is the default focus and the safe default. An operator who presses
 *     Enter or Escape destroys nothing.
 *   - The destructive action is styled `variant="destructive"` so it cannot be
 *     mistaken for the confirming action.
 *   - The dialog names the CONSEQUENCE in the description, not just "are you
 *     sure" — which is the part a native confirm actually cannot convey.
 *   - `open` is derived from a target, so there is no boolean that can drift out
 *     of sync with what is actually about to be deleted.
 *   - `dir` is threaded through so the Arabic layout renders RTL rather than
 *     inheriting LTR from the button that opened it.
 *
 * Note on RTL: shadcn's AlertDialog is built on Radix, which reads `dir` from
 * the DOM. The app sets `dir` on <html>, so a dialog rendered into the normal
 * tree inherits it. This prop exists for the case where a dialog is rendered in
 * a subtree that overrides direction.
 */

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDir } from "@/lib/fgmp/use-language";

export interface ConfirmDestructiveTarget {
  /**
   * Dialog heading. Names the ACTION ("Delete handover"), not the object, so a
   * screen reader announces what pressing Enter will do.
   */
  title: string;
  /**
   * What will happen, in the operator's terms. This is the part a native
   * confirm cannot convey and the reason this component exists — it should say
   * the CONSEQUENCE, not restate the question.
   */
  description: string;
  /** Cancel button label. */
  cancelLabel: string;
  /** Confirm button label. Should name the action, not say "OK". */
  confirmLabel: string;
}

export interface ConfirmDestructiveProps {
  /** null when nothing is pending confirmation. */
  target: ConfirmDestructiveTarget | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Disables the confirm button while the action is in flight. */
  busy?: boolean;
}

export function ConfirmDestructive({
  target,
  onCancel,
  onConfirm,
  busy = false,
}: ConfirmDestructiveProps) {
  const dir = useDir();
  const open = target !== null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Any dismissal — Escape, overlay click, or Cancel — is a refusal.
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent dir={dir}>
        <AlertDialogHeader>
          <AlertDialogTitle>{target?.title ?? ""}</AlertDialogTitle>
          <AlertDialogDescription>{target?.description ?? ""}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel renders first in the DOM so it is the default focus target. */}
          <AlertDialogCancel disabled={busy}>{target?.cancelLabel ?? ""}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Do not let Radix auto-close before the caller has handled the
              // result; the caller closes by clearing the target, which also
              // keeps the dialog open while `busy` if the request is slow.
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {target?.confirmLabel ?? ""}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Convenience state hook for the common "one pending target" pattern.
 *
 * Returns `ask()` to open, `settle()` to clear, and `dialogProps` minus
 * `onConfirm` — the caller supplies that, because only it knows what to do.
 *
 * Intended usage:
 *
 *     const c = useDestructiveConfirm();
 *     const remove = async (id: string) => {
 *       c.setBusy(true);
 *       const res = await fetch(`/api/.../${id}`, { method: "DELETE" });
 *       c.settle();
 *       ...
 *     };
 *     ...
 *     <Button onClick={() => c.ask({ title: t("x.deleteTitle"), ... })}>…</Button>
 *     <ConfirmDestructive
 *       {...c.dialogProps}
 *       onConfirm={() => remove(pendingId)}
 *     />
 *
 * Kept here so no caller has to invent its own boolean and get the
 * cancellation semantics wrong: every dismissal is a refusal, by construction.
 */
export function useDestructiveConfirm() {
  const [target, setTarget] = React.useState<ConfirmDestructiveTarget | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Declared as a binding rather than inlined into the returned object.
  // `settle` referenced itself from within the object literal it was defined in,
  // which resolves to nothing at that point in the evaluation — it compiled as
  // `TS2304: Cannot find name 'settle'` and would have thrown a ReferenceError
  // the moment an operator cancelled a deletion. The most safety-relevant
  // interaction in the component (the one that must NOT perform the action) was
  // the broken one.
  const settle = React.useCallback(() => {
    setTarget(null);
    setBusy(false);
  }, []);

  return {
    target,
    busy,
    ask: (t: ConfirmDestructiveTarget) => setTarget(t),
    settle,
    setBusy,
    dialogProps: {
      target,
      busy,
      onCancel: settle,
    },
  };
}