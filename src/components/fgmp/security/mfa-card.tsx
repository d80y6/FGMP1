"use client";

/**
 * Self-service MFA enrolment — the UI for the endpoints that already existed.
 *
 * ── WHY THIS CARD WAS THE MISSING PIECE ────────────────────────────────────
 * The MFA machine was complete and unreachable. `/api/fgmp/mfa/enrol`,
 * `/verify-enrol`, `/status` and `/disable` were implemented, audited,
 * rate-limited and covered by tests — and nothing in the product called them, so
 * the only way to enrol was to drive the API by hand. A second factor that
 * requires a curl command is a second factor nobody has, which makes the login
 * challenge (`/mfa/challenge`) a wall in front of an account that cannot pass it.
 *
 * ── THE THREE STATES, AND WHY THE BACKUP CODES BLOCK ───────────────────────
 *   1. not enrolled      → "Set up", which reveals the secret and the otpauth URI
 *   2. secret shown      → a code must come back before anything is enabled
 *   3. codes shown ONCE  → the step cannot be left without acknowledging
 *
 * State 3 is deliberately not a toast. `verify-enrol` stores only bcrypt hashes,
 * so the plaintext codes exist in exactly one response and are never recoverable
 * — not by the user, not by support, not by a super-admin. If the panel let the
 * operator close the dialog and "get them later", the recovery path would be a
 * two-person break-glass reset instead of the codes they were just given. The
 * acknowledgement checkbox exists for that reason and for that reason only.
 *
 * ── NO QR CODE, ON PURPOSE ─────────────────────────────────────────────────
 * Rendering a QR needs a library this repository does not have, and adding one
 * for a single field is not worth the supply-chain surface. The otpauth URI is
 * shown in full, monospaced and selectable, which every authenticator app
 * accepts by copy-paste; the secret is shown separately for manual entry. A
 * broken QR that silently encodes the wrong issuer is worse than no QR.
 */

import { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, KeyRound, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { apiPost, useApi } from "@/lib/fgmp/use-api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDateTime } from "@/lib/fgmp/format";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { toast } from "sonner";

interface MfaStatus {
  configured: boolean;
  enabled: boolean;
  enrolled: boolean;
  enrolledAt: string | null;
  lastUsedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  backupCodesRemaining: number;
  lowBackupCodes?: boolean;
  noRecoveryCodes?: boolean;
  digits?: number;
  periodSeconds?: number;
  problem?: string;
}

const CODE_LENGTH = 6;
const DISABLE_REASON_MIN = 5;

export function MfaCard() {
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  const { data: status, loading, refetch } = useApi<MfaStatus>("/api/fgmp/mfa/status", {
    interval: 60_000,
  });

  /** Steps of the enrolment flow. `codes` is terminal until acknowledged. */
  const [step, setStep] = useState<"idle" | "secret" | "codes">("idle");
  const [secret, setSecret] = useState("");
  const [otpauth, setOtpauth] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState("");
  const [disableReason, setDisableReason] = useState("");

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("mfa.copied"));
    } catch {
      // Clipboard access can be denied; the value is selectable on screen, so
      // this is a convenience failure, not an error worth a red toast.
      toast.error(t("mfa.copyFailed"));
    }
  }, [t]);

  const begin = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await apiPost("/api/fgmp/mfa/enrol", {});
      if (res.ok) {
        const data = res.data as { secret: string; otpauthUri: string };
        setSecret(data.secret);
        setOtpauth(data.otpauthUri);
        setCode("");
        setStep("secret");
      } else {
        // A 400 here is the environment: `mfaEncryptionConfigured()` is false,
        // or the session is not tenant-scoped. The message is the operator's
        // to fix, so it is shown verbatim rather than replaced with "failed".
        setProblem(res.error ?? t("mfa.enrolFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (code.replace(/\s/g, "").length < CODE_LENGTH) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await apiPost("/api/fgmp/mfa/verify-enrol", { code: code.trim() });
      if (res.ok) {
        const data = res.data as { backupCodes: string[] };
        setBackupCodes(data.backupCodes);
        setAcknowledged(false);
        setStep("codes");
        refetch();
      } else {
        setProblem(res.error ?? t("mfa.verifyFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    if (!acknowledged) return;
    setStep("idle");
    setSecret("");
    setOtpauth("");
    setCode("");
    setBackupCodes([]);
    setAcknowledged(false);
    refetch();
  };

  const disable = async () => {
    if (disableReason.trim().length < DISABLE_REASON_MIN) return;
    setBusy(true);
    try {
      const res = await apiPost("/api/fgmp/mfa/disable", {
        code: disableCode.trim(),
        reason: disableReason.trim(),
      });
      if (res.ok) {
        toast.success(t("mfa.disabledToast"));
        setDisableOpen(false);
        setDisableCode("");
        setDisableReason("");
        refetch();
      } else {
        toast.error(res.error ?? t("common.error"));
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("mfa.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  const configured = status?.configured ?? false;
  const enabled = status?.enabled ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {enabled ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ShieldOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          )}
          {t("mfa.title")}
          <Badge
            className={
              enabled
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[10px]"
                : "bg-muted text-muted-foreground text-[10px]"
            }
          >
            {enabled ? t("mfa.stateOn") : t("mfa.stateOff")}
          </Badge>
        </CardTitle>
        <CardDescription className="mt-0.5 text-xs">{t("mfa.desc")}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Not configured: the honest answer. Offering a setup button that
            fails at /enrol is worse than saying the deployment cannot do it. */}
        {!configured ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("mfa.unavailable")}</AlertTitle>
            <AlertDescription>{status?.problem ?? t("mfa.unavailableHint")}</AlertDescription>
          </Alert>
        ) : enabled ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span>
                {t("mfa.enrolledAt")}:{" "}
                <span className="font-medium text-foreground" dir="ltr">
                  {status?.enrolledAt ? fmtDateTime(status.enrolledAt, numLang) : "—"}
                </span>
              </span>
              <span>
                {t("mfa.lastUsed")}:{" "}
                <span className="font-medium text-foreground" dir="ltr">
                  {status?.lastUsedAt ? fmtDateTime(status.lastUsedAt, numLang) : t("mfa.never")}
                </span>
              </span>
              <span>
                {t("mfa.backupCodesRemaining")}:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {formatNumber(status?.backupCodesRemaining ?? 0, numLang)}
                </span>
              </span>
            </div>

            {status?.noRecoveryCodes && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t("mfa.noCodes")}</AlertTitle>
                <AlertDescription>{t("mfa.noCodesHint")}</AlertDescription>
              </Alert>
            )}
            {!status?.noRecoveryCodes && status?.lowBackupCodes && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t("mfa.lowCodes")}</AlertTitle>
                <AlertDescription>{t("mfa.lowCodesHint")}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setDisableOpen((o) => !o)}>
                <ShieldOff className="me-1.5 h-4 w-4" />
                {t("mfa.disable")}
              </Button>
              <span className="text-[10px] text-muted-foreground">{t("mfa.disableHint")}</span>
            </div>

            {disableOpen && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-[11px] text-muted-foreground">{t("mfa.disableDesc")}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="mfa-disable-code" className="text-[11px]">{t("mfa.code")}</Label>
                    <Input
                      id="mfa-disable-code"
                      value={disableCode}
                      onChange={(e) => setDisableCode(e.target.value)}
                      placeholder="123456"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className="h-8 font-mono text-xs tracking-widest"
                      dir="ltr"
                      maxLength={20}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mfa-disable-reason" className="text-[11px]">{t("mfa.reason")}</Label>
                    <Input
                      id="mfa-disable-reason"
                      value={disableReason}
                      onChange={(e) => setDisableReason(e.target.value)}
                      placeholder={t("mfa.reasonPlaceholder")}
                      className="h-8 text-xs"
                      maxLength={500}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {disableReason.trim().length < DISABLE_REASON_MIN ? t("mfa.reasonTooShort") : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 text-[11px]"
                    onClick={disable}
                    disabled={
                      busy ||
                      disableCode.trim().length < CODE_LENGTH ||
                      disableReason.trim().length < DISABLE_REASON_MIN
                    }
                  >
                    {t("mfa.disableConfirm")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : step === "idle" ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={begin} disabled={busy}>
              <KeyRound className="me-1.5 h-4 w-4" />
              {t("mfa.setUp")}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t("mfa.setUpHint")}</p>
          </div>
        ) : step === "secret" ? (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">{t("mfa.step1")}</p>
            <div className="space-y-1">
              <Label className="text-[11px]">{t("mfa.secret")}</Label>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded border bg-muted/40 px-2 py-1.5 font-mono text-[11px]" dir="ltr">
                  {secret}
                </code>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void copy(secret)} aria-label={t("mfa.copy")}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">{t("mfa.otpauth")}</Label>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded border bg-muted/40 px-2 py-1.5 font-mono text-[10px]" dir="ltr">
                  {otpauth}
                </code>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void copy(otpauth)} aria-label={t("mfa.copy")}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("mfa.step2")}</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="mfa-enrol-code" className="text-[11px]">{t("mfa.code")}</Label>
                <Input
                  id="mfa-enrol-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="h-8 w-[140px] font-mono text-sm tracking-widest"
                  dir="ltr"
                  maxLength={10}
                />
              </div>
              <Button size="sm" onClick={confirm} disabled={busy || code.replace(/\s/g, "").length < CODE_LENGTH}>
                <CheckCircle2 className="me-1.5 h-4 w-4" />
                {t("mfa.verify")}
              </Button>
              <Button size="sm" variant="ghost" onClick={begin} disabled={busy}>
                <RefreshCw className="me-1.5 h-3.5 w-3.5" />
                {t("mfa.newSecret")}
              </Button>
            </div>
            {problem && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t("mfa.verifyFailedTitle")}</AlertTitle>
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>{t("mfa.codesTitle")}</AlertTitle>
              <AlertDescription>{tFmt("mfa.codesWarning", { n: backupCodes.length })}</AlertDescription>
            </Alert>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {backupCodes.map((c) => (
                <code
                  key={c}
                  className="rounded border bg-muted/40 px-2 py-1 text-center font-mono text-[11px] tracking-wider"
                  dir="ltr"
                >
                  {c}
                </code>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void copy(backupCodes.join("\n"))}>
                <Copy className="me-1.5 h-4 w-4" />
                {t("mfa.copyAll")}
              </Button>
            </div>
            <label className="flex items-start gap-2 text-[11px]">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>{t("mfa.codesAcknowledge")}</span>
            </label>
            <div className="flex justify-end">
              <Button size="sm" onClick={finish} disabled={!acknowledged}>
                {t("mfa.codesDone")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
