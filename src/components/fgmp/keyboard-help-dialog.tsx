"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Keyboard } from "lucide-react";
import { KEYBOARD_SHORTCUTS } from "@/lib/fgmp/use-keyboard-shortcuts";
import { useT } from "@/lib/fgmp/use-language";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardHelpDialog({ open, onOpenChange }: Props) {
  const t = useT();
  // Alarms-view-specific shortcuts. These are local to the alarms view
  // (registered via a useEffect in alarms-view.tsx) so they live alongside
  // the dialog rather than in the global KEYBOARD_SHORTCUTS array.
  const ALARM_SHORTCUTS: { keys: string; description: string }[] = [
    { keys: "A", description: "Acknowledge selected alarms" },
    { keys: "R", description: "Resolve selected alarms" },
    { keys: "Esc", description: "Clear selection / heatmap filter / detail panel" },
  ];

  const grouped = KEYBOARD_SHORTCUTS.reduce<Record<string, typeof KEYBOARD_SHORTCUTS>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});

  // Insert the Alarms section right after the Actions group so it appears
  // before the TIP box at the bottom of the dialog.
  const orderedEntries: [string, { keys: string; description: string }[]][] = [
    ...Object.entries(grouped).filter(([cat]) => cat !== "Actions"),
    ...Object.entries(grouped).filter(([cat]) => cat === "Actions"),
    ["Alarms", ALARM_SHORTCUTS],
  ];

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
          <div className="space-y-4 pr-2">
            {orderedEntries.map(([category, shortcuts]) => (
              <div key={category}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {category}
                </p>
                <div className="space-y-1.5">
                  {shortcuts.map((s) => (
                    <div key={s.keys + s.description} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                      <span className="text-sm text-foreground">{s.description}</span>
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
                <Badge variant="outline" className="mr-1.5 h-4 px-1 text-[10px] border-emerald-500/30 text-emerald-700 dark:text-emerald-400">
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
