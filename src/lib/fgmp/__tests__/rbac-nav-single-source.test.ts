/**
 * One navigation table, two surfaces.
 * ─────────────────────────────────────────────────────────────────────────────
 * The sidebar and the command palette each used to carry their own view list,
 * and the lists drifted: 28 entries in `app-shell.tsx`, 22 in
 * `command-palette.tsx`. Five views existed in one surface and not the other, so
 * the same role could see a screen in the sidebar and be unable to reach it from
 * the palette (and vice versa) — and every capability added later had to be
 * added twice, with nothing to fail when it was added once.
 *
 * Both now render from `NAV_ENTRIES` (`src/lib/fgmp/navigation.ts`). This file
 * is the guard on that arrangement, because "both import the same array" is a
 * property that stays true only while someone checks it:
 *
 *   1. Neither surface keeps a private list, and neither hard-codes a
 *      `cap: "view:…"` literal. A capability may exist in exactly one place.
 *   2. The table is complete: every view the shell can mount has an entry, so a
 *      screen cannot exist without a way to reach it.
 *   3. Each entry's capability is exactly `view:<key>`. A typo here
 *      (`view:systemHealth`, `view:tenant_isolation`) hides the entry from every
 *      role, including SUPERADMIN — the wildcard matches capabilities, not view
 *      names — so the screen ships unreachable and no type error appears.
 *   4. Each entry is visible to at least one role. An entry gated on a
 *      capability nobody holds is dead weight that looks like a feature.
 *   5. Each surface has an icon for every entry. `ICONS[key]` returning
 *      undefined is a render-time crash (`undefined` is not a component), and
 *      the palette's map is hand-written.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_ENTRIES } from "../navigation";
import { hasCapability, ROLE_PERMISSIONS, type Role } from "../rbac-core";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SHELL = read("src/components/fgmp/app-shell.tsx");
const PALETTE = read("src/components/fgmp/command-palette.tsx");

const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

/** Keys of a hand-written `const NAME: Record<ViewKey, …> = { … }` map. */
function recordKeys(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf("{", source.indexOf("=", start));
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open, end);
  return [...body.matchAll(/^\s*"?([a-z-]+)"?:\s*[A-Z]/gm)]
    .map((m) => m[1])
    .filter((k) => k in NAV_INDEX);
}

const NAV_INDEX: Record<string, true> = Object.fromEntries(NAV_ENTRIES.map((e) => [e.key, true as const]));

describe("navigation is defined once", () => {
  test("neither surface keeps a private view list", () => {
    // The old shapes: a `NAV_ITEMS` array in the palette, and a `cap: "view:…"`
    // literal in either component outside the shared module.
    expect(/const\s+NAV_ITEMS\b/.test(PALETTE)).toBe(false);
    expect(/cap:\s*"view:/.test(PALETTE)).toBe(false);
    expect(/cap:\s*"view:/.test(SHELL)).toBe(false);
  });

  test("both surfaces read the shared table", () => {
    expect(SHELL).toContain('from "@/lib/fgmp/navigation"');
    expect(PALETTE).toContain('from "@/lib/fgmp/navigation"');
    expect(SHELL).toContain("NAV_ENTRIES");
    expect(PALETTE).toContain("NAV_ENTRIES");
  });

  test("both surfaces filter by capability, not by role name", () => {
    // A role literal in the visible-nav filter is the same policy stated twice.
    expect(PALETTE).toContain("hasCapability(role, n.cap)");
    expect(SHELL).toContain("hasCapability(role, n.cap)");
  });
});

describe("the table is complete and honest", () => {
  test("every mountable view is reachable", () => {
    // VIEW_COMPONENTS is the shell's map of what it knows how to render.
    const mountable = recordKeys(SHELL, "VIEW_COMPONENTS");
    expect(mountable.length).toBeGreaterThanOrEqual(20);
    const missing = mountable.filter((k) => !NAV_INDEX[k]);
    expect(missing).toEqual([]);
  });

  test("no duplicate entries", () => {
    const keys = NAV_ENTRIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("each entry's capability is exactly view:<key>", () => {
    // The wildcard "*" is a capability wildcard, not a view wildcard: a
    // misspelled cap hides the entry from SUPERADMIN too.
    expect(NAV_ENTRIES.filter((e) => e.cap !== `view:${e.key}`).map((e) => `${e.key} → ${e.cap}`)).toEqual([]);
  });

  test("every entry is visible to at least one role", () => {
    const orphans = NAV_ENTRIES.filter((e) => !ROLES.some((r) => hasCapability(r, e.cap))).map((e) => e.key);
    expect(orphans).toEqual([]);
  });

  test("group ids are drawn from NAV_GROUPS", () => {
    const groups = new Set(["operations", "monitoring", "logistics", "insights", "administration", "account"]);
    expect(NAV_ENTRIES.filter((e) => !groups.has(e.group)).map((e) => `${e.key} → ${e.group}`)).toEqual([]);
  });
});

describe("each surface can render every entry", () => {
  test("the sidebar has an icon for every entry", () => {
    const icons = recordKeys(SHELL, "NAV_ICONS");
    expect(NAV_ENTRIES.filter((e) => !icons.includes(e.key)).map((e) => e.key)).toEqual([]);
  });

  test("the palette has an icon for every entry", () => {
    const icons = recordKeys(PALETTE, "ICONS");
    expect(NAV_ENTRIES.filter((e) => !icons.includes(e.key)).map((e) => e.key)).toEqual([]);
  });

  test("every entry has an i18n label key of the form nav.<something>", () => {
    expect(NAV_ENTRIES.filter((e) => !e.tKey.startsWith("nav.")).map((e) => `${e.key} → ${e.tKey}`)).toEqual([]);
  });
});

describe("keyboard shortcuts are the table's, not a copy", () => {
  test("no two entries claim the same shortcut", () => {
    // The palette printed "G R" next to both Asset Registry and Reports while
    // only one of them was bound. A duplicate here means at least one printed
    // hint is a lie.
    const used = NAV_ENTRIES.map((e) => e.shortcut).filter((s): s is string => !!s);
    const dupes = used.filter((s, i) => used.indexOf(s) !== i);
    expect(dupes).toEqual([]);
  });

  test("every shortcut is a `G <letter>` pair the handler can parse", () => {
    const bad = NAV_ENTRIES.filter((e) => e.shortcut && !/^G [A-Z]$/.test(e.shortcut)).map((e) => `${e.key}: ${e.shortcut}`);
    expect(bad).toEqual([]);
  });

  test("the handler and the help dialog both derive from NAV_ENTRIES", () => {
    const hooks = read("src/lib/fgmp/use-keyboard-shortcuts.ts");
    expect(hooks).toContain("NAV_ENTRIES");
    // The old hand-written map: a 12-entry literal that had to be kept in step
    // with three other copies.
    expect(/const\s+NAV_SHORTCUTS:\s*Record<string,\s*ViewKey>\s*=\s*\{/.test(hooks)).toBe(false);
    expect(hooks).toContain('import { NAV_ENTRIES } from "@/lib/fgmp/navigation"');
    // The derived map must lower-case the letter: the handler lower-cases
    // `e.key`, so an upper-case key would bind nothing at all.
    expect(hooks).toContain("toLowerCase()");
  });

  test("the help dialog translates nav rows instead of printing the key", () => {
    // `descKey` rows are `nav.*` keys; rendering `description` would print
    // "nav.dashboard" into the dialog.
    const dialog = read("src/components/fgmp/keyboard-help-dialog.tsx");
    expect(dialog).toContain("descKey");
  });
});
