"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Zap, AlertOctagon, RotateCcw, Power } from "lucide-react";
import { apiPost } from "@/lib/fgmp/use-api";
import { toast } from "sonner";
import type { GenCommand } from "@/lib/fgmp/types";
import { useT, useTF } from "@/lib/fgmp/use-language";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  generatorId: string | null;
  generatorLabel: string;
  siteName: string;
  command: GenCommand;
  onDone?: () => void;
}

const CMD_META: Record<GenCommand, { title: string; icon: typeof Zap; tone: string; confirm: string }> = {
  START: { title: "Remote Start", icon: Power, tone: "bg-emerald-500 hover:bg-emerald-600", confirm: "Start generator" },
  STOP: { title: "Remote Stop", icon: Power, tone: "bg-amber-500 hover:bg-amber-600", confirm: "Stop generator" },
  EMERGENCY_STOP: { title: "Emergency Stop", icon: AlertOctagon, tone: "bg-rose-600 hover:bg-rose-700", confirm: "Execute EMERGENCY STOP" },
  RESET: { title: "Reset Fault", icon: RotateCcw, tone: "bg-sky-500 hover:bg-sky-600", confirm: "Reset fault" },
};

export function RemoteControlDialog({ open, onOpenChange, generatorId, generatorLabel, siteName, command, onDone }: Props) {
  const t = useT();
  const tFmt = useTF();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const meta = CMD_META[command];
  const Icon = meta.icon;
  const isEmergency = command === "EMERGENCY_STOP";

  const submit = async () => {
    if (!generatorId) return;
    setBusy(true);
    const res = await apiPost(`/api/fgmp/generators/${generatorId}/control`, { command, reason });
    setBusy(false);
    if (res.ok) {
      toast.success(`${meta.title} executed`, { description: `${generatorLabel} at ${siteName}` });
      onOpenChange(false);
      setReason("");
      onDone?.();
    } else {
      toast.error(`${meta.title} failed`, { description: res.error ?? "Command could not be executed" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={isEmergency ? "h-5 w-5 text-rose-500" : "h-5 w-5 text-emerald-500"} />
            {meta.title}
          </DialogTitle>
          <DialogDescription>
            {tFmt("remoteControl.confirmOn", { generator: generatorLabel, site: siteName })}
          </DialogDescription>
        </DialogHeader>

        {isEmergency && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-400">
            <AlertOctagon className="mb-1 inline h-4 w-4" /> {t("remoteControl.emergencyNote")}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="reason" className="text-xs">{t("remoteControl.reasonLabel")}</Label>
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("remoteControl.reasonPlaceholder")} rows={2} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={busy} className={`text-white ${meta.tone}`}>
            {busy ? "Executing…" : meta.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
