"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

/**
 * Site Notes / Annotations store.
 *
 * Persisted to localStorage under "fgmp:site-notes" as a JSON array of
 * SiteNote objects. SSR-safe: starts empty on the server and the first client
 * render, then hydrates inside a useEffect to avoid hydration mismatches.
 *
 * Mirrors the use-favorites.ts pattern: Zustand + manual localStorage
 * read/write + storage-event cross-tab sync + useSiteNotesHydration hook.
 */

const STORAGE_KEY = "fgmp:site-notes";
const MAX_TEXT_LENGTH = 1000;

export interface SiteNote {
  id: string;
  siteId: string;
  text: string;
  author: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp — equals createdAt on initial creation */
  updatedAt: string;
  pinned: boolean;
}

interface SiteNotesState {
  notes: SiteNote[];
  hydrated: boolean;
  addNote: (siteId: string, text: string, author: string) => void;
  updateNote: (id: string, text: string) => void;
  deleteNote: (id: string) => void;
  togglePin: (id: string) => void;
  /** Plain (non-reactive) lookup — prefer useNotesForSite() in components. */
  getNotesForSite: (siteId: string) => SiteNote[];
  /** Re-read localStorage into state (called on mount + on storage events). */
  hydrate: () => void;
}

/** Generate a unique id without depending on browser-only APIs. */
function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Cap note text at MAX_TEXT_LENGTH chars. */
function clampText(s: string): string {
  return s.length > MAX_TEXT_LENGTH ? s.slice(0, MAX_TEXT_LENGTH) : s;
}

/**
 * Sanitise a raw parsed value into a valid SiteNote, or return null if it
 * should be dropped (missing required fields / wrong types).
 */
function sanitizeNote(raw: unknown): SiteNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.siteId !== "string" || !r.siteId) return null;
  if (typeof r.text !== "string") return null;
  if (typeof r.author !== "string" || !r.author) return null;
  if (typeof r.createdAt !== "string" || !r.createdAt) return null;
  if (typeof r.updatedAt !== "string" || !r.updatedAt) return null;
  if (typeof r.pinned !== "boolean") return null;
  return {
    id: r.id,
    siteId: r.siteId,
    text: clampText(r.text),
    author: r.author,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    pinned: r.pinned,
  };
}

function readFromStorage(): SiteNote[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: SiteNote[] = [];
    for (const item of parsed) {
      const note = sanitizeNote(item);
      if (!note) continue;
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      out.push(note);
    }
    return out;
  } catch {
    return [];
  }
}

function writeToStorage(notes: SiteNote[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // Ignore quota / privacy-mode errors — persistence is best-effort.
  }
}

/** Sort: pinned first, then by updatedAt descending (most recent on top). */
function sortNotes(notes: SiteNote[]): SiteNote[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export const useSiteNotes = create<SiteNotesState>((set, get) => ({
  notes: [],
  hydrated: false,
  addNote: (siteId, text, author) => {
    if (!siteId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    const note: SiteNote = {
      id: genId(),
      siteId,
      text: clampText(trimmed),
      author: author || "Operator",
      createdAt: now,
      updatedAt: now,
      pinned: false,
    };
    const next = [note, ...get().notes];
    writeToStorage(next);
    set({ notes: next });
  },
  updateNote: (id, text) => {
    if (!id) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const next = get().notes.map((n) =>
      n.id === id
        ? { ...n, text: clampText(trimmed), updatedAt: new Date().toISOString() }
        : n,
    );
    writeToStorage(next);
    set({ notes: next });
  },
  deleteNote: (id) => {
    if (!id) return;
    const next = get().notes.filter((n) => n.id !== id);
    writeToStorage(next);
    set({ notes: next });
  },
  togglePin: (id) => {
    if (!id) return;
    const next = get().notes.map((n) =>
      n.id === id ? { ...n, pinned: !n.pinned } : n,
    );
    writeToStorage(next);
    set({ notes: next });
  },
  getNotesForSite: (siteId) => {
    if (!siteId) return [];
    return sortNotes(get().notes.filter((n) => n.siteId === siteId));
  },
  hydrate: () => {
    const notes = readFromStorage();
    set({ notes, hydrated: true });
  },
}));

const EMPTY_NOTES: SiteNote[] = [];

/**
 * Reactive selector: returns the sorted notes for a single site, re-rendering
 * the component when notes for that site change. Returns [] during SSR / before
 * hydration so the first paint is stable.
 *
 * Uses useShallow to memoise the returned array reference — without it, the
 * selector would produce a fresh array on every store change and trigger an
 * infinite render loop ("The result of getSnapshot should be cached").
 */
export function useNotesForSite(siteId: string | null | undefined): SiteNote[] {
  return useSiteNotes(
    useShallow((s) => {
      if (!siteId) return EMPTY_NOTES;
      if (!s.hydrated) return EMPTY_NOTES;
      const filtered = s.notes.filter((n) => n.siteId === siteId);
      return sortNotes(filtered);
    }),
  );
}

/**
 * Mount this once near the top of the client tree (or inside any component
 * that consumes site notes) to hydrate the store from localStorage and keep
 * it in sync across tabs (storage events).
 */
export function useSiteNotesHydration(): void {
  const hydrate = useSiteNotes((s) => s.hydrate);

  useEffect(() => {
    hydrate();

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) hydrate();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrate]);
}
