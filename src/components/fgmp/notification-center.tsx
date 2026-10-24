"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Bell, CheckCheck, X, MessageSquare, Mail, Smartphone, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/fgmp/format";
import { useApi, apiPost } from "@/lib/fgmp/use-api";
import { useFgmp } from "@/lib/fgmp/store";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import { useT } from "@/lib/fgmp/use-language";
import { useNow } from "@/lib/fgmp/use-now";

interface Notification {
  id: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  alarmId: string | null;
  status: string;
  attempts: number;
  sentAt: string | null;
  createdAt: string;
}

const CHANNEL_ICON: Record<string, typeof Mail> = {
  EMAIL: Mail,
  SMS: Smartphone,
  WHATSAPP: MessageSquare,
  PUSH: Bell,
  CONSOLE: Send,
};

const CHANNEL_COLOR: Record<string, string> = {
  EMAIL: "text-sky-500 bg-sky-500/10",
  SMS: "text-violet-500 bg-violet-500/10",
  WHATSAPP: "text-emerald-500 bg-emerald-500/10",
  PUSH: "text-amber-500 bg-amber-500/10",
  CONSOLE: "text-slate-500 bg-slate-500/10",
};

function extractSeverity(subject: string): string | null {
  const m = subject.match(/\[ESCALATION (L\d)\]/i) || subject.match(/\[(L\d)\]/i);
  return m ? m[1] : null;
}

export function NotificationCenter() {
  const t = useT();
  const role = useFgmp((s) => s.me?.role ?? null);
  const canDismissNotifications = role !== null && hasCapability(role, "notification:manage");
  const [open, setOpen] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  // Poll fast while the panel is open (the list is on screen), slowly while it
  // is closed. This used to poll every 10s unconditionally for the lifetime of
  // the session — six times a minute for a badge most operators look at rarely.
  // The badge still refreshes, just at a cadence that matches how often it can
  // actually be seen; opening the panel drops straight back to 10s.
  const { data: notifications, refetch } = useApi<Notification[]>("/api/fgmp/notifications", {
    interval: open ? 10000 : 60000,
  });
  const prevCountRef = useRef(0);

  const unreadCount = useMemo(() => {
    if (!notifications) return 0;
    return notifications.filter((n) => !readIds.has(n.id) && n.status !== "SENT").length;
  }, [notifications, readIds]);

  // Track new notifications for badge animation
  useEffect(() => {
    if (notifications && notifications.length > prevCountRef.current && prevCountRef.current > 0) {
      // New notifications arrived
    }
    if (notifications) prevCountRef.current = notifications.length;
  }, [notifications]);

  const markAllRead = () => {
    if (!notifications) return;
    setReadIds(new Set(notifications.map((n) => n.id)));
  };

  const markRead = (id: string) => {
    setReadIds((prev) => new Set(prev).add(id));
  };

  const dismissAll = async () => {
    if (!notifications || !canDismissNotifications) return;
    // Mark all as sent (acknowledged)
    for (const n of notifications.filter((n) => n.status === "QUEUED")) {
      await apiPost("/api/fgmp/notifications", { action: "markSent", notificationId: n.id });
    }
    markAllRead();
    toast.success(t("common.allDismissed"));
    refetch();
  };

  const isUnread = (n: Notification) => !readIds.has(n.id) && n.status !== "SENT";

  // Group by time period
  const now = useNow();
  const grouped = useMemo(() => {
    if (!notifications) return { recent: [], earlier: [] };
    const recent = notifications.filter((n) => now - new Date(n.createdAt).getTime() < 30 * 60 * 1000);
    const earlier = notifications.filter((n) => now - new Date(n.createdAt).getTime() >= 30 * 60 * 1000);
    return { recent, earlier };
  }, [notifications, now]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="relative" aria-label={t("common.notifications")}
          title={t("common.notifications")}>
          <Bell className={cn("h-4 w-4 transition-colors", unreadCount > 0 && "text-amber-500")} />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white animate-in zoom-in-50 duration-200">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="end" sideOffset={8}>
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{t("common.notifications")}</h3>
            {unreadCount > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {unreadCount} new
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={markAllRead}>
                <CheckCheck className="mr-1 h-3 w-3" />
                Mark all read
              </Button>
            )}
            {canDismissNotifications && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={dismissAll}>
                <X className="mr-1 h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Notification list */}
        <ScrollArea className="h-[400px]">
          {!notifications || notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Bell className="mb-2 h-8 w-8 opacity-30" />
              <p className="text-sm">{t("common.noNotifications")}</p>
              <p className="text-xs">{t("common.notificationsHint")}</p>
            </div>
          ) : (
            <>
              {grouped.recent.length > 0 && (
                <div>
                  <p className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Recent
                  </p>
                  {grouped.recent.map((n) => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      isUnread={isUnread(n)}
                      onRead={markRead}
                    />
                  ))}
                </div>
              )}
              {grouped.earlier.length > 0 && (
                <div>
                  {grouped.recent.length > 0 && <Separator />}
                  <p className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Earlier
                  </p>
                  {grouped.earlier.map((n) => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      isUnread={isUnread(n)}
                      onRead={markRead}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </ScrollArea>

        {/* Footer */}
        {notifications && notifications.length > 0 && (
          <div className="border-t px-4 py-2">
            <p className="text-center text-[10px] text-muted-foreground">
              {notifications.length} total · {unreadCount} unread
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function NotificationItem({
  notification,
  isUnread,
  onRead,
}: {
  notification: Notification;
  isUnread: boolean;
  onRead: (id: string) => void;
}) {
  const severity = extractSeverity(notification.subject);
  const ChannelIcon = CHANNEL_ICON[notification.channel] || Send;
  const channelColor = CHANNEL_COLOR[notification.channel] || "text-slate-500 bg-slate-500/10";

  const handleClick = () => {
    if (isUnread) onRead(notification.id);
  };

  return (
    <button
      className={cn(
        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50",
        isUnread && "bg-muted/30"
      )}
      onClick={handleClick}
    >
      {/* Channel icon */}
      <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", channelColor)}>
        <ChannelIcon className="h-4 w-4" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className={cn("text-xs leading-tight", isUnread ? "font-semibold" : "font-medium")}>
            {notification.subject}
          </p>
          {isUnread && (
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-rose-500" />
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
          {notification.body}
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{timeAgo(notification.createdAt)}</span>
          {severity && (
            <Badge
              variant="outline"
              className={cn(
                "h-4 px-1 text-[8px] font-bold",
                severity === "L3"
                  ? "border-rose-500/30 text-rose-500"
                  : severity === "L2"
                  ? "border-amber-500/30 text-amber-500"
                  : "border-sky-500/30 text-sky-500"
              )}
            >
              {severity}
            </Badge>
          )}
          <Badge variant="outline" className="h-4 px-1 text-[8px]">
            {notification.channel}
          </Badge>
          {notification.status === "QUEUED" && (
            <Badge variant="outline" className="h-4 px-1 text-[8px] border-amber-500/30 text-amber-500">
              Pending
            </Badge>
          )}
          {notification.status === "SENT" && (
            <Badge variant="outline" className="h-4 px-1 text-[8px] border-emerald-500/30 text-emerald-500">
              Sent
            </Badge>
          )}
        </div>
      </div>
    </button>
  );
}
