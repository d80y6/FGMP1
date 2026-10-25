/**
 * Static guards for the four accessibility defects the browser sweep found.
 *
 * WHY A STATIC TEST AND NOT ONLY THE E2E SWEEP
 * --------------------------------------------
 * `tests/e2e/views.e2e.ts` is the authority: it renders every view in Chromium
 * and runs axe. But it needs a seeded database and a downloaded browser, so it
 * runs in one CI job and not at all on a laptop without either. These guards
 * run in 40 ms with `bun test`, catch the same four shapes at the point they
 * are written, and name the file and line instead of a CSS selector path.
 *
 * THE FOUR, AND WHAT EACH ONE ACTUALLY WAS
 * ----------------------------------------
 * 1. `button-name` (critical, 4 views). A Radix Select trigger is
 *    `<button role="combobox">`. A combobox is named by aria-label /
 *    aria-labelledby — NEVER by its contents — so a trigger showing "All
 *    regions" still has no accessible name. axe reported 2–3 unnamed buttons
 *    per filtered table. The fix was structural: `Select` now requires `label`
 *    and forwards it through context (`components/ui/select.tsx`).
 *
 * 2. `aria-valid-attr-value` (critical, 3 views). `<TabsTrigger>` with no
 *    `<TabsContent>` of the same value: Radix emits `aria-controls` pointing at
 *    a panel that does not exist. Those controls were filters, not tabs, and
 *    are now `<FilterTabs>` (role="radiogroup").
 *
 * 3. `aria-prohibited-attr` (serious, dashboard ×3). `aria-label` on a plain
 *    `<div>`: prohibited, and the div was not focusable, so the tooltip it
 *    opened was unreachable by keyboard. Now a real `<button>`.
 *
 * 4. `color-contrast` (serious, ~55 nodes across 5 views). `text-*-600` was
 *    used for both themes. Against the LIGHT card it passes (~4.6:1), but the
 *    app defaults to DARK, where the same class measures ~2.9:1 — a red
 *    "EMERGENCY STOP" that is hard to read is the worst possible place to
 *    fail contrast. Every one is now `text-*-700 dark:text-*-400`.
 *
 * ROUND 4 ADDITIONS
 * -----------------
 * 6. `button-name` again, but on switches. A Radix Switch renders
 *    `<button role="switch">` with no text, so its name comes only from an
 *    aria-label or from a <Label htmlFor> pointing at its id. Three unlabelled
 *    toggles on the notification-settings cards were the whole of a critical
 *    finding. A switch is now accepted only if one of those exists.
 *
 * 7. `aria-progressbar-name`. `<Progress>` renders `role="progressbar"`, which
 *    also cannot take its name from contents. The label prop is required at the
 *    type level; this guard keeps it required, because one `label?:` edit would
 *    silently unname every bar in the app.
 *
 * 8. `nested-interactive`. A `role="button"` container with a real <button>
 *    inside it is two controls in one, and neither can be operated reliably
 *    from the keyboard. Rows are now a real <button> plus a text link.
 *
 * 9. Chart roots in the tab order. Recharts puts `tabindex="0"` on its root
 *    <svg>; without `accessibilityLayer` that stop does nothing. Every chart is
 *    either announced once by a wrapper (aria-hidden, or role="img" + label) or
 *    not at all — never a dead tab stop.
 *
 * Run: bun test src/lib/fgmp/__tests__/a11y-guards.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const COMPONENTS = join(ROOT, "src", "components");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Blank block and line comments, keeping newlines, so reported lines are true. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}


/** The markup inside an element, up to its own closing tag, by tag depth. */
function innerContent(src: string, from: number, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "g");
  const close = new RegExp(`</${tag}>`, "g");
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    open.lastIndex = i;
    close.lastIndex = i;
    const o = open.exec(src);
    const c = close.exec(src);
    if (!c) break;
    if (o && o.index < c.index) {
      // Self-closing tags never open a level.
      if (!o[0].endsWith("/>")) depth++;
      i = o.index + o[0].length;
    } else {
      depth--;
      i = c.index + c[0].length;
      if (depth === 0) return src.slice(from, c.index);
    }
  }
  return src.slice(from);
}

/**
 * The source of one JSX opening tag, from `<` to its terminating `>`.
 *
 * `indexOf(">")` is wrong: a handler like `onCheckedChange={() => toggle()}` has
 * a `>` inside the braces, and cutting there hides every prop after it — which
 * is exactly how an `aria-label` on a <Switch> was reported missing.
 */
function tagText(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start, start + 400);
}

type Finding = { file: string; line: number; detail: string };

function findings(): Finding[] {
  const out: Finding[] = [];
  for (const file of walk(COMPONENTS)) {
    const raw = readFileSync(file, "utf8");
    const src = stripComments(raw);
    const rel = relative(ROOT, file);
    const at = (index: number) => src.slice(0, index).split("\n").length;
    const push = (index: number, detail: string) => out.push({ file: rel, line: at(index), detail });

    // ── 1. every <Select> names its trigger ──────────────────────────────
    // The trigger is the <button role="combobox">; only the root can see the
    // visible label, so the name has to be passed at the root.
    for (const m of src.matchAll(/<Select(?=[\s>])/g)) {
      const rest = src.slice(m.index, m.index + 400);
      const tagEnd = rest.indexOf(">");
      const tag = rest.slice(0, tagEnd);
      if (!/\blabel=/.test(tag)) {
        push(m.index, "<Select> without label= — its trigger will have no accessible name");
      }
    }

    // ── 2. every <TabsTrigger> has a panel ───────────────────────────────
    for (const m of src.matchAll(/<TabsTrigger\s+value="([^"]+)"/g)) {
      const value = m[1];
      const hasPanel = new RegExp(`<TabsContent\\s+value="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(src);
      if (!hasPanel) {
        push(m.index, `<TabsTrigger value="${value}"> has no <TabsContent> — aria-controls would dangle`);
      }
    }

    // ── 3. aria-label only on things that permit it ──────────────────────
    // A generic <div>/<span> may not carry an accessible name (axe:
    // aria-prohibited-attr); it needs a role, or the label belongs on a control.
    for (const m of src.matchAll(/<(div|span|p)(\s[^>]*?)aria-label=/g)) {
      const attrs = m[2] ?? "";
      if (!/\brole=/.test(attrs)) {
        push(m.index, `<${m[1]}> with aria-label but no role — use a control, or add role`);
      }
    }

    // ── 4. no bare text-*-600 (2.9:1 on the dark card) ───────────────────
    // 700 is the light-theme shade; each needs the explicit dark: counterpart.
    for (const m of src.matchAll(/(?<!dark:)text-(rose|emerald|amber|sky|orange|red|violet|cyan|blue|green|yellow|teal|indigo|purple|lime|fuchsia|pink)-600\b/g)) {
      const line = at(m.index);
      const lineText = src.split("\n")[line - 1] ?? "";
      const pair = `dark:text-${m[1]}-400`;
      if (!lineText.includes(pair)) {
        push(m.index, `${m[0]} with no ${pair} — unreadable on the default dark theme`);
      }
    }

    // ── 5. a scroll container that traps content is keyboard-reachable ───
    // axe: scrollable-region-focusable. Only a TRAP matters: a max-height box
    // with no focusable child. If the rows inside contain a link, a button or
    // a checkbox, a keyboard user reaches the region by focusing those, and
    // axe does not report it either — flagging those 15 boxes would have been
    // noise that made the guard get switched off.
    for (const m of src.matchAll(/<(div|section)(\s[^>]*?)>/g)) {
      const attrs = m[2] ?? "";
      if (!/\bmax-h-\[[^\]]+\]/.test(attrs)) continue;
      if (!/\boverflow-y-auto\b/.test(attrs)) continue;
      if (/\btabIndex=/.test(attrs)) continue;
      const inner = innerContent(src, m.index + m[0].length, m[1]);
      if (!/<(a|button|input|select|Link|Button|Checkbox|Switch|Select)\b/.test(inner)) {
        push(m.index, "scrollable max-height box with nothing focusable inside — keyboard users cannot scroll it");
      }
    }

    // ── 6. every <Switch> has a name ────────────────────────────────────
    // Radix renders <button role="switch"> with no contents, so the name must
    // come from aria-label/-labelledby, or from a <Label htmlFor> pointing at
    // the id it renders with.
    for (const m of src.matchAll(/<Switch(?=[\s/>])/g)) {
      const tag = tagText(src, m.index);
      if (/\baria-label(ledby)?=/.test(tag)) continue;
      const id = /\bid=("([^"]+)"|\{[^]*?\})(?=\s|\/?>)/.exec(tag);
      if (id) {
        const raw = (id[2] ?? id[1]).trim();
        // A template id is only half-visible in source: `toggle-active-${id}`
        // gives the static prefix, which is what htmlFor also starts with.
        const body = raw.replace(/^\{/, "").replace(/[`}]/g, "");
        const prefix = body.split("${")[0];
        // `id={someVar}` cannot be checked statically; do not guess.
        const opaque = raw.startsWith("{") && !raw.includes("$");
        const named =
          opaque ||
          (prefix.length > 0 &&
            (src.includes(`htmlFor="${prefix}`) || src.includes("htmlFor={`" + prefix)));
        if (!named) {
          push(m.index, `<Switch id=${raw}> has no <Label htmlFor> in this file`);
        }
        continue;
      }
      // Inside <FormControl> react-hook-form supplies the id and label wiring.
      const before = src.slice(Math.max(0, m.index - 300), m.index);
      if (/<FormControl>\s*$/.test(before) || /<FormControl>\s*\n\s*$/.test(before)) continue;
      push(m.index, "<Switch> with no aria-label and no id — an unnamed switch");
    }

    // ── 7. every <Progress> is named ────────────────────────────────────
    // role="progressbar" is never named by contents, so the label is required.
    for (const m of src.matchAll(/<Progress(?=[\s/>])/g)) {
      const tag = tagText(src, m.index);
      if (!/\blabel=|\baria-label(ledby)?=/.test(tag)) {
        push(m.index, "<Progress> without label= — an unnamed progressbar");
      }
    }

    // ── 8. no control inside a control ──────────────────────────────────
    for (const m of src.matchAll(/<(div|section|li|tr|span)(\s[^>]*?)role="(button|link)"/g)) {
      const inner = innerContent(src, m.index + m[0].length, m[1]);
      if (/<(button|a|Link|Button)\b/.test(inner)) {
        push(m.index, `role="${m[3]}" container with a real control inside — nested interactive`);
      }
    }

    // ── 9. chart roots are not tab stops ────────────────────────────────
    for (const m of src.matchAll(/<(PieChart|ScatterChart|BarChart|LineChart|AreaChart|RadarChart|Treemap|ComposedChart)(?=[\s/>])/g)) {
      const tag = tagText(src, m.index);
      if (!/\btabIndex=\{-1\}/.test(tag)) {
        push(m.index, `<${m[1]}> without tabIndex={-1} — a chart root in the tab order that does nothing`);
      }
    }
  }
  return out;
}

const ALL = findings();

describe("accessibility regression guards", () => {
  test("every Select trigger has an accessible name", () => {
    const bad = ALL.filter((f) => f.detail.startsWith("<Select>"));
    assert.deepEqual(bad, [], `${bad.length} unnamed Select(s)`);
  });

  test("no tab trigger points at a panel that does not exist", () => {
    const bad = ALL.filter((f) => f.detail.includes("has no <TabsContent>"));
    assert.deepEqual(bad, [], `${bad.length} dangling tab trigger(s)`);
  });

  test("aria-label is only used where the role permits a name", () => {
    const bad = ALL.filter((f) => f.detail.includes("aria-label but no role"));
    assert.deepEqual(bad, [], `${bad.length} prohibited aria-label(s)`);
  });

  test("no text-*-600 without its dark-theme counterpart", () => {
    const bad = ALL.filter((f) => f.detail.includes("unreadable on the default dark theme"));
    assert.deepEqual(bad, [], `${bad.length} low-contrast class(es)`);
  });

  test("scrollable max-height boxes are keyboard-reachable", () => {
    const bad = ALL.filter((f) => f.detail.includes("keyboard users cannot scroll it"));
    assert.deepEqual(bad, [], `${bad.length} unreachable scroll region(s)`);
  });

  test("every switch has an accessible name", () => {
    const bad = ALL.filter((f) => f.detail.includes("unnamed switch") || f.detail.includes("has no <Label htmlFor>"));
    assert.deepEqual(bad, [], `${bad.length} unnamed switch(es)`);
  });

  test("every progressbar is named", () => {
    const bad = ALL.filter((f) => f.detail.includes("unnamed progressbar"));
    assert.deepEqual(bad, [], `${bad.length} unnamed progressbar(s)`);
  });

  test("no interactive control is nested inside another", () => {
    const bad = ALL.filter((f) => f.detail.includes("nested interactive"));
    assert.deepEqual(bad, [], `${bad.length} nested control(s)`);
  });

  test("no chart root sits in the tab order", () => {
    const bad = ALL.filter((f) => f.detail.includes("chart root in the tab order"));
    assert.deepEqual(bad, [], `${bad.length} focusable chart root(s)`);
  });

  test("Progress keeps its label prop required", () => {
    const src = readFileSync(join(COMPONENTS, "ui", "progress.tsx"), "utf8");
    assert.match(src, /label:\s*string/);
    assert.doesNotMatch(src, /label\?:/);
  });

  test("the scan actually reads the tree", () => {
    // A guard that silently scans nothing passes forever.
    const files = walk(COMPONENTS);
    assert.ok(files.length > 100, `expected the component tree, found ${files.length} files`);
    const selects = files.reduce((n, f) => n + (readFileSync(f, "utf8").match(/<Select(?=[\s>])/g)?.length ?? 0), 0);
    assert.ok(selects >= 60, `expected ~69 Selects in the tree, counted ${selects}`);
    const charts = files.reduce((n, f) => n + (readFileSync(f, "utf8").match(/<(PieChart|ScatterChart|BarChart|LineChart|AreaChart|RadarChart|Treemap|ComposedChart)(?=[\s/>])/g)?.length ?? 0), 0);
    assert.ok(charts >= 25, `expected ~30 recharts roots, counted ${charts}`);
  });
});
