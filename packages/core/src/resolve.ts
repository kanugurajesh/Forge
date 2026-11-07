import type { Locator } from "./types.ts";
import type { SnapshotNode } from "./trajectory.ts";
import { anchoredName, classifyLocator, parseSerialisedRegex, textMatches, type Tier } from "./locator.ts";

/**
 * Locator → snapshot resolution. The compiler uses it to prove a proposed
 * locator is unique against the recorded snapshot; the runner uses the exact
 * same function against a live snapshot, so "unique at compile time" and
 * "resolves at replay time" mean the same thing.
 */

function strEq(pattern: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const re = parseSerialisedRegex(pattern);
  return re ? re.test(value) : pattern === value;
}

export function nodeMatches(node: SnapshotNode, loc: Locator): boolean {
  const a = node.attrs ?? {};
  if (loc.role && node.role !== loc.role) return false;
  if (loc.name !== undefined && !textMatches(loc.name, node.name)) return false;
  if (loc.aria_label !== undefined && !strEq(loc.aria_label, a["aria-label"])) return false;
  if (loc.data_testid !== undefined && !strEq(loc.data_testid, a["data-testid"])) return false;
  if (loc.href !== undefined && !(a.href ?? "").includes(loc.href)) return false;
  if (loc.attr && !strEq(loc.attr.value, a[loc.attr.name])) return false;
  const text = node.text ?? node.name;
  if (loc.has_text !== undefined && !textMatches(loc.has_text, text)) return false;
  if (loc.has_text_not !== undefined && textMatches(loc.has_text_not, text)) return false;
  return true;
}

export function resolveLocator(snapshot: SnapshotNode[], loc: Locator): SnapshotNode[] {
  const matches = snapshot.filter((n) => nodeMatches(n, loc));
  if (loc.nth !== undefined) return matches[loc.nth] ? [matches[loc.nth]] : [];
  return matches;
}

export interface Proposal {
  unique: boolean;
  locator: Locator;
  tier: Tier;
  fragile: boolean;
  warnings: string[];
  candidates: { locator: Locator; tier: Tier; matches: number }[];
}

/**
 * Smallest, highest-tier descriptor that resolves to exactly `target`.
 * Same preference order as BrowserOps' browser_propose_locator:
 * tier-1 contract attributes → tier-2 role+anchored name → tier-3 nth.
 */
export function proposeLocator(target: SnapshotNode, snapshot: SnapshotNode[]): Proposal {
  const a = target.attrs ?? {};
  const raw: Locator[] = [];
  if (a["data-testid"]) raw.push({ data_testid: a["data-testid"] });
  if (a["aria-label"]) raw.push({ aria_label: a["aria-label"] });
  if (a["aria-label"]) raw.push({ role: target.role, aria_label: a["aria-label"] });
  if (a.name) raw.push({ attr: { name: "name", value: a.name } });
  if (a.id && !/\d{3,}|^:r|^radix-|^headlessui-/.test(a.id)) raw.push({ attr: { name: "id", value: a.id } });
  if (a.href && target.role === "link") raw.push({ role: "link", href: a.href });
  if (target.name) raw.push({ role: target.role, name: anchoredName(target.name) });
  if (target.text && target.text !== target.name) raw.push({ role: target.role, has_text: anchoredName(target.text) });

  const candidates = raw.map((locator) => ({
    locator,
    tier: (classifyLocator(locator) ?? 3) as Tier,
    matches: resolveLocator(snapshot, locator).length,
  }));

  const unique = candidates
    .filter((c) => c.matches === 1 && resolveLocator(snapshot, c.locator)[0]?.ref === target.ref)
    .sort((x, y) => x.tier - y.tier || Object.keys(x.locator).length - Object.keys(y.locator).length);

  if (unique.length > 0) {
    const best = unique[0];
    const warnings: string[] = [];
    if (best.tier === 2) warnings.push("tier-2 locator: depends on visible copy; add a data-testid or aria-label to harden");
    return { unique: true, locator: best.locator, tier: best.tier, fragile: false, warnings, candidates };
  }

  // Fall through to positional: role + name + nth.
  const base: Locator = target.name ? { role: target.role, name: anchoredName(target.name) } : { role: target.role };
  const pool = resolveLocator(snapshot, base);
  const idx = Math.max(0, pool.findIndex((n) => n.ref === target.ref));
  const locator = { ...base, nth: idx };
  return {
    unique: false,
    locator,
    tier: 3,
    fragile: true,
    warnings: ["tier-3 (nth) locator: no stable attribute disambiguates this control"],
    candidates,
  };
}
