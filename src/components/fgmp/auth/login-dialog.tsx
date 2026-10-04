"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { signIn } from "next-auth/react";
import { Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/fgmp/use-language";

/**
 * FGMP Login Dialog (Task 31-A)
 * ────────────────────────────────────────────────────────────────────────────
 * Modal login form backed by NextAuth's credentials provider. Mounted by
 * AppShell whenever the session is unauthenticated (the whole app is hidden
 * behind this dialog until the user signs in).
 *
 * Flow:
 *   1. User fills email + password.
 *   2. Submit → signIn("credentials", { …, redirect: false }).
 *   3. On success: toast + close dialog (AppShell re-renders authenticated).
 *   4. On error: toast "Invalid credentials" + keep dialog open.
 *
 * Validation:
 *   - email: must be a valid email address.
 *   - password: min 6 chars (the seed admin password is 10 chars; this is a
 *     client-side sanity check, not a security boundary — bcrypt is the
 *     real check on the server).
 */
const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

type LoginValues = z.infer<typeof loginSchema>;

interface LoginDialogProps {
  open: boolean;
  /** Optional callback invoked after a successful sign-in. */
  onSuccess?: () => void;
}

export function LoginDialog({ open, onSuccess }: LoginDialogProps) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  async function onSubmit(values: LoginValues) {
    setSubmitting(true);
    try {
      const res = await signIn("credentials", {
        email: values.email.trim().toLowerCase(),
        password: values.password,
        redirect: false,
      });
      if (!res || res.error) {
        // Don't distinguish "user not found", "locked", "wrong password" —
        // all collapse to a generic invalid-credentials message so we don't
        // leak account-existence information.
        const isLocked = res?.error === "CredentialsSignin";
        toast.error(isLocked ? t("auth.invalidCredentials") : t("auth.invalidCredentials"));
        return;
      }
      toast.success(t("auth.loginSuccess"));
      form.reset();
      onSuccess?.();
    } catch {
      toast.error(t("auth.invalidCredentials"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>{t("auth.loginTitle")}</DialogTitle>
              <DialogDescription className="mt-0.5">
                {t("auth.loginSubtitle")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("auth.email")}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      autoFocus
                      placeholder={t("auth.enterEmail")}
                      aria-label={t("auth.email")}
                      disabled={submitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("auth.password")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      placeholder={t("auth.enterPassword")}
                      aria-label={t("auth.password")}
                      disabled={submitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-2">
              <Button
                type="submit"
                className="w-full"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("auth.signingIn")}
                  </>
                ) : (
                  <>
                    <LockKeyhole className="h-4 w-4" />
                    {t("auth.signIn")}
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
