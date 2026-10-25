"use client";

import { useEffect, useRef, useState } from "react";
import {
  StickyNote,
  Pin,
  PinOff,
  Edit3,
  Trash2,
  X,
  Plus,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDestructive } from "./confirm-destructive";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFgmp } from "@/lib/fgmp/store";
import { timeAgo } from "@/lib/fgmp/format";
import {
  useSiteNotes,
  useSiteNotesHydration,
  useNotesForSite,
} from "@/lib/fgmp/use-site-notes";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/fgmp/use-language";

const MAX_LEN = 1000;

interface SiteNotesPanelProps {
  siteId: string;
  siteName: string;
  readOnly?: boolean;
}

export function SiteNotesPanel({
  siteId,
  siteName,
  readOnly = false,
}: SiteNotesPanelProps) {
  const t = useT();
  // Hydrate the notes store from localStorage wherever this panel mounts.
  useSiteNotesHydration();

  const me = useFgmp((s) => s.me);
  const author = me?.name ?? t("notes.operator");

  const notes = useNotesForSite(siteId);
  const addNote = useSiteNotes((s) => s.addNote);
  const updateNote = useSiteNotes((s) => s.updateNote);
  const deleteNote = useSiteNotes((s) => s.deleteNote);
  const togglePin = useSiteNotes((s) => s.togglePin);

  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Phase 5 task 4 — which note the confirm dialog is about.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const draftEmpty = draft.trim().length === 0;
  const counterTone =
    draft.length >= 950
      ? "text-rose-500"
      : draft.length >= 800
        ? "text-amber-500"
        : "text-muted-foreground";

  // When entering edit mode, scroll the composer into view + focus the textarea.
  useEffect(() => {
    if (editingId) {
      composerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      // Defer focus to the next tick so the textarea is mounted with new value.
      const t = window.setTimeout(() => {
        textareaRef.current?.focus();
        // Place cursor at end.
        const el = textareaRef.current;
        if (el) {
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
      }, 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [editingId]);

  function handleAdd() {
    if (readOnly || draftEmpty) return;
    if (editingId) {
      updateNote(editingId, draft);
      setEditingId(null);
      setDraft("");
      toast.success(t("notes.noteUpdated"));
      return;
    }
    addNote(siteId, draft.trim(), author);
    setDraft("");
    toast.success(t("notes.noteAdded"));
  }

  function handleEdit(id: string, text: string) {
    if (readOnly) return;
    setEditingId(id);
    setDraft(text);
  }

  function handleCancelEdit() {
    setEditingId(null);
    setDraft("");
  }

  function handleTogglePin(id: string, currentlyPinned: boolean) {
    if (readOnly) return;
    togglePin(id);
    toast.success(currentlyPinned ? t("notes.noteUnpinned") : t("notes.notePinned"));
  }

  // Phase 5 task 4: the delete is split into "ask" and "perform" so the
  // design-system dialog can gate it. The old shape could not: it asked and
  // then immediately acted, in one function.
  function performDelete(id: string) {
    deleteNote(id);
    // If we were editing this note, cancel the edit session.
    if (editingId === id) {
      setEditingId(null);
      setDraft("");
    }
    toast.success(t("notes.noteDeleted"));
    setPendingDeleteId(null);
  }

  function handleDelete(id: string) {
    if (readOnly) return;
    setPendingDeleteId(id);
  }

  const count = notes.length;

  return (
    <>
    <div className="rounded-lg border bg-card text-card-foreground">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <StickyNote className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-semibold">{t("notes.title")}</span>
        <Badge
          variant="secondary"
          className="ml-1 h-5 px-1.5 text-[10px] font-bold tabular-nums"
        >
          {count} {count === 1 ? t("notes.note") : t("notes.notes")}
        </Badge>
        {readOnly && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("notes.readOnly")}
          </span>
        )}
      </div>

      {/* Composer */}
      {!readOnly && (
        <div
          ref={composerRef}
          className="space-y-2 border-b px-3 py-3"
        >
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={MAX_LEN}
            placeholder={`${t("notes.placeholder")} ${siteName}…`}
            className={cn(
              "min-h-[72px] resize-y text-sm leading-relaxed",
              "placeholder:text-muted-foreground",
              "transition-[color,box-shadow] duration-150",
              "focus-visible:ring-2 focus-visible:ring-emerald-500/30",
              "focus-visible:border-emerald-500/50",
            )}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {editingId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={handleCancelEdit}
                >
                  <X className="mr-1 h-3 w-3" />
                  {t("notes.cancel")}
                </Button>
              )}
              {!editingId && draft.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => setDraft("")}
                >
                  <X className="mr-1 h-3 w-3" />
                  {t("notes.clear")}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "font-mono text-[10px] tabular-nums",
                  counterTone,
                )}
              >
                {draft.length}/{MAX_LEN}
              </span>
              <Button
                type="button"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={draftEmpty}
                onClick={handleAdd}
              >
                {editingId ? (
                  <>
                    <Check className="mr-1 h-3 w-3" />
                    {t("notes.saveEdit")}
                  </>
                ) : (
                  <>
                    <Plus className="mr-1 h-3 w-3" />
                    {t("notes.addNote")}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Notes list */}
      <div className="px-3 py-2.5">
        {count === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center">
            <StickyNote className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {t("notes.empty")}
            </p>
          </div>
        ) : (
          <div className="site-notes-scroll max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
            {notes.map((note) => (
              <div
                key={note.id}
                className={cn(
                  "group animate-in fade-in slide-in-from-bottom-1 duration-200",
                  "relative rounded-md border bg-background/40 p-2.5",
                  "border-l-2 transition-colors",
                  note.pinned
                    ? "border-l-amber-500"
                    : "border-l-transparent hover:bg-muted/30",
                  !note.pinned && "hover:bg-muted/30",
                )}
              >
                {/* Top row: author + relative time + pinned badge */}
                <div className="mb-1 flex items-center gap-1.5">
                  {note.pinned && (
                    <Pin className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" />
                  )}
                  <span className="text-xs font-medium text-foreground">
                    {note.author}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {timeAgo(note.updatedAt)}
                  </span>
                  {note.pinned && (
                    <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                      {t("notes.pinned")}
                    </span>
                  )}
                </div>

                {/* Note body */}
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
                  {note.text}
                </p>

                {/* Action row — only visible to non-readOnly users, on hover */}
                {!readOnly && (
                  <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-amber-700 dark:hover:text-amber-400"
                          onClick={() => handleTogglePin(note.id, note.pinned)}
                        >
                          {note.pinned ? (
                            <>
                              <PinOff className="mr-1 h-3 w-3" />
                              {t("notes.unpin")}
                            </>
                          ) : (
                            <>
                              <Pin className="mr-1 h-3 w-3" />
                              {t("notes.pin")}
                            </>
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {note.pinned ? t("notes.unpinTip") : t("notes.pinTip")}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-sky-700 dark:hover:text-sky-400"
                          onClick={() => handleEdit(note.id, note.text)}
                          disabled={editingId === note.id}
                        >
                          <Edit3 className="mr-1 h-3 w-3" />
                          {t("notes.edit")}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("notes.editTip")}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] text-muted-foreground hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-400"
                          onClick={() => handleDelete(note.id)}
                        >
                          <Trash2 className="mr-1 h-3 w-3" />
                          {t("notes.delete")}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("notes.deleteTip")}</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
      <ConfirmDestructive
        target={
          pendingDeleteId
            ? {
                title: t("confirm.deleteTitle"),
                description: t("notes.deleteConfirm"),
                cancelLabel: t("confirm.cancel"),
                confirmLabel: t("confirm.deleteTitle"),
              }
            : null
        }
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={() => pendingDeleteId && performDelete(pendingDeleteId)}
      />
    </>
  );
}
