/**
 * Procedure search. `tokenize` reproduces BrowserOps' tokenizer (stop words +
 * light stemming) so a query that finds a procedure locally via
 * procedures_search also finds it in the Hub.
 */
const STOP_WORDS = new Set(
  "a an the and or but if then else of for in on at to from by with is are was were be been being am has have had do does did me my you your he his she her it its we our they their them us this that these those what which who whom where when why how dont just so not no yes maybe also please want need".split(
    " ",
  ),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => {
      if (t.endsWith("ing") && t.length - 3 >= 3) return t.slice(0, -3);
      if (t.endsWith("ed") && t.length - 2 >= 3) return t.slice(0, -2);
      if (t.endsWith("s") && t.length - 1 >= 3) return t.slice(0, -1);
      return t;
    });
}

export interface Searchable {
  name: string;
  description: string;
  domain?: string;
  triggers?: string[];
  tags?: string[];
}

/** Weighted token overlap in [0,1]. Name/domain hits weigh more than description. */
export function scoreProcedure(query: string, p: Searchable): number {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return 0;
  const fields: [string, number][] = [
    [p.name.replace(/[._]/g, " "), 3],
    [p.domain ?? "", 3],
    [(p.triggers ?? []).join(" "), 2],
    [(p.tags ?? []).join(" "), 1.5],
    [p.description, 1],
  ];
  let hit = 0;
  for (const t of q) {
    let best = 0;
    for (const [text, w] of fields) {
      const toks = tokenize(text);
      if (toks.includes(t)) best = Math.max(best, w);
      else if (toks.some((x) => x.startsWith(t) && t.length >= 3)) best = Math.max(best, w * 0.6);
    }
    hit += best / 3;
  }
  return Math.min(1, hit / q.length);
}
