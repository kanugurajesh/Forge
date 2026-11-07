import type { Locator } from "./types.ts";

/**
 * Locator stability tiers — identical to BrowserOps' FIELD_TIERS
 * (shared/dist/locator-stability.js).
 *   Tier 1: author/contract-controlled, survives rebuilds.
 *   Tier 2: text/layout-derived, churns when copy or DOM order changes.
 *   Tier 3: positional, breaks on reorder.
 */
export const FIELD_TIERS: Record<string, 1 | 2 | 3> = {
  aria_label: 1,
  data_testid: 1,
  href: 1,
  attr: 1,
  role: 1,
  in_frame: 1,
  name: 2,
  has_text: 2,
  has_text_not: 2,
  near: 2,
  nth: 3,
};

export type Tier = 1 | 2 | 3;

/** Worst (highest) tier among the locator's populated fields. */
export function classifyLocator(loc: Locator | undefined): Tier | null {
  if (!loc) return null;
  let worst: Tier | null = null;
  for (const [key, value] of Object.entries(loc)) {
    if (value === undefined || value === null || key === "scope") continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (key === "name" && isExclusionName(value)) continue; // guard-only constraint, not copy
    const tier = FIELD_TIERS[key];
    if (tier === undefined) continue;
    if (worst === null || tier > worst) worst = tier;
  }
  return worst;
}

/** Parse BrowserOps' serialised regex form: "/^send$/i". */
export function parseSerialisedRegex(value: unknown): RegExp | undefined {
  if (typeof value !== "string" || value.length < 2 || value[0] !== "/") return undefined;
  const lastSlash = value.lastIndexOf("/");
  if (lastSlash <= 0) return undefined;
  const flags = value.slice(lastSlash + 1);
  if (!/^[gimsuy]*$/.test(flags)) return undefined;
  try {
    return new RegExp(value.slice(1, lastSlash), flags);
  } catch {
    return undefined;
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Anchored, case-insensitive serialised regex for an exact accessible name. */
export function anchoredName(name: string): string {
  return `/^${escapeRegex(name.trim())}$/i`;
}

/** Text matcher semantics used across Forge: regex form or case-insensitive substring. */
export function textMatches(pattern: string, text: string): boolean {
  const re = parseSerialisedRegex(pattern);
  if (re) return re.test(text);
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function matchString(value: string, pattern: string): boolean {
  const re = parseSerialisedRegex(pattern);
  if (re) return re.test(value);
  return value.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * BrowserOps' static forbidden guard (bridge `procedures/forbidden.ts`,
 * `locatorOverlaps`), ported verbatim. It runs on the step's *descriptor*, not
 * on the element it resolves to, and only compares `role` and `name`: a step
 * locator that omits either one cannot be proven safe, so it "overlaps".
 * Consequence: `{data_testid: "compose-button"}` is refused next to a
 * `{role: "button", name: "/^Archive$/i"}` forbidden entry.
 */
export function forbiddenOverlaps(denied: Locator, candidate: Locator): boolean {
  if (denied.role) {
    if (candidate.role !== undefined && !candidate.role.toLowerCase().includes(denied.role.toLowerCase())) return false;
  }
  if (denied.name) {
    if (candidate.name) {
      const a = denied.name;
      const b = candidate.name;
      if (!(a === b || matchString(a, b) || matchString(b, a))) return false;
    }
  }
  return true;
}

const EXCLUSION_PREFIX = "/^(?!.*(?:";

/** `name` pattern meaning "any name except these" — written only to satisfy the forbidden guard. */
export function exclusionName(names: string[]): string {
  return `${EXCLUSION_PREFIX}${names.map((n) => escapeRegex(n.trim())).join("|")})).*$/i`;
}

export function isExclusionName(v: unknown): boolean {
  return typeof v === "string" && v.startsWith(EXCLUSION_PREFIX);
}

/**
 * Make a step locator pass BrowserOps' static forbidden guard without losing
 * stability. Adds the target's role; if the role still collides and the
 * locator has a tier-1 anchor (testid/aria-label/attr/href), adds an exclusion
 * name ("anything but the forbidden names") so copy changes still resolve. A
 * role-only locator gets the target's anchored name instead. Returns a note
 * when the locator changed.
 */
export function hardenForForbidden(
  loc: Locator,
  target: { role: string; name: string },
  forbidden: Locator[],
): string | undefined {
  if (!forbidden.some((f) => forbiddenOverlaps(f, loc))) return undefined;
  const before = JSON.stringify(loc);
  if (!loc.role) loc.role = target.role;
  if (forbidden.some((f) => forbiddenOverlaps(f, loc)) && !loc.name) {
    const anchored = loc.data_testid || loc.aria_label || loc.attr || loc.href;
    if (anchored) {
      const names = forbidden.map((f) => f.name).filter((n): n is string => !!n).map((n) => parseSerialisedRegex(n)?.source.replace(/^\^|\$$/g, "").replace(/\\(.)/g, "$1") ?? n);
      loc.name = exclusionName([...new Set(names)]);
    } else if (target.name) {
      loc.name = anchoredName(target.name);
    }
  }
  return JSON.stringify(loc) === before ? undefined : `${before} → ${JSON.stringify(loc)}`;
}

/** Human-readable one-liner for UIs and reports. */
export function describeLocator(loc: Locator | undefined): string {
  if (!loc) return "—";
  const parts: string[] = [];
  if (loc.data_testid) parts.push(`testid=${loc.data_testid}`);
  if (loc.aria_label) parts.push(`aria-label="${loc.aria_label}"`);
  if (loc.role) parts.push(`role=${loc.role}`);
  if (loc.name) parts.push(`name=${loc.name}`);
  if (loc.attr) parts.push(`[${loc.attr.name}="${loc.attr.value}"]`);
  if (loc.href) parts.push(`href~${loc.href}`);
  if (loc.has_text) parts.push(`text~${loc.has_text}`);
  if (loc.has_text_not) parts.push(`!text~${loc.has_text_not}`);
  if (loc.nth !== undefined) parts.push(`nth=${loc.nth}`);
  return parts.join(" ");
}
