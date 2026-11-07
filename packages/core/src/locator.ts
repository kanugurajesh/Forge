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
