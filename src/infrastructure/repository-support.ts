/** Small helpers shared by the repository implementations. */

/** Comparator: ascending by an ISO-8601 string field (nulls sort first). */
export function byIsoAscending<T>(pick: (item: T) => string | null): (a: T, b: T) => number {
  return (a, b) => Date.parse(pick(a) ?? '') - Date.parse(pick(b) ?? '');
}

export function applyLimit<T>(items: readonly T[], limit: number | undefined): T[] {
  return limit === undefined ? [...items] : items.slice(0, Math.max(0, limit));
}
