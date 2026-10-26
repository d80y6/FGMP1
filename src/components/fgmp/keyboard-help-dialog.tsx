"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Keyboard } from "lucide-react";
import { KEYBOARD_SHORTCUTS } from "@/lib/fgmp/use-keyboard-shortcuts";
import { useT } from "@/lib/fgmp/use-language";
import { useFgmp } from "@/lib/fgmp/store";
import { hasCapability } from "@/lib/fgmp/rbac-core";

/** A row in the help dialog: literal text, or an i18n key, plus its group. */
type ShortcutRow = { keys: string; description?: string; descKey?: string; categoryKey?: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardHelpDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const role = useFgmp((s) => s.me?.role ?? null);
  const can = (cap: string) => role !== null && hasCapability(role, cap);

  // Alarms-view-specific shortcuts. These are local to the alarms view
  // (registered via a useEffect in alarms-view.tsx) so they live alongside
  // the dialog rather than in the global KEYBOARD_SHORTCUTS array.
  //
  // A and R are filtered by their capability for the same reason the buttons
  // they mirror are: a help dialog is documentation of what the keyboard can
  // do, and documenting a key that no-ops (or 403s) is the same lie as a
  // button that does.
  const ALARM_SHORTCUTS: ShortcutRow[] = [
    ...(can("alarm:ack") ? [{ keys: "A", descKey: "keyboard.action.ackSelected" }] : []),
    ...(can("alarm:resolve") ? [{ keys: "R", descKey: "keyboard.action.resolveSelected" }] : []),
    { keys: "Esc", descKey: "keyboard.action.clearSelection" },
  ];

  // Navigation shortcuts are listed only for views this role may open.
  const grouped = KEYBOARD_SHORTCUTS
    .filter((s) => !s.cap || can(s.cap))
    .reduce<Record<string, typeof KEYBOARD_SHORTCUTS>>((acc, s) => {
      (acc[s.category] ??= []).push(s);
      return acc;
    }, {});

  // Insert the Alarms section right after the Actions group so it appears
  // before the TIP box at the bottom of the dialog.
  // Rows carry either literal `description` or an i18n `descKey`; the dialog
  // resolves both here so no caller has to remember which it holds.
  const orderedEntries: [string, ShortcutRow[]][] = [
    ...Object.entries(grouped).filter(([cat]) => cat !== "Actions"),
    ...Object.entries(grouped).filter(([cat]) => cat === "Actions"),
    [t("keyboard.category.alarms"), ALARM_SHORTCUTS],
  ];
  const label = (s: ShortcutRow) => (s.descKey ? t(s.descKey) : (s.description ?? ""));
  const categoryKeyOf = (rows: ShortcutRow[]) => rows.find((r) => r.categoryKey)?.categoryKey;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-emerald-500" />
            {t("common.keyboardShortcuts")}
          </DialogTitle>
          <DialogDescription>
            {t("keyboard.desc")}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-4 pe-2">
            {orderedEntries.map(([category, shortcuts]) => (
              <div key={category}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {categoryKeyOf(shortcuts) ? t(categoryKeyOf(shortcuts) as string) : category}
                </p>
                <div className="space-y-1.5">
                  {shortcuts.map((s) => (
                    <div key={s.keys + label(s)} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                      <span className="text-sm text-foreground">{label(s)}</span>
                      <kbd className="inline-flex items-center gap-0.5 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                        {s.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                <Badge variant="outline" className="me-1.5 h-4 px-1 text-[10px] border-emerald-500/30 text-emerald-700 dark:text-emerald-400">
                  {t("keyboard.tip")}
                </Badge>
                {t("keyboard.gPrefixTip")}
              </p>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
