/** Containers larger than this many items/entries never render inline. */
export const LARGE_GROUP = 20

/**
 * True when a value can render as a quiet inline run — pills and
 * `key: value` pairs on one flowing line — instead of a foldable panel.
 *
 * The rule is shape-driven, never domain-driven:
 *
 * - primitives and empty containers are always compact;
 * - a scalar-only object (`{provider, updatedAt}`) reads as one line;
 * - an object that *purely groups* compact values — no scalar beside a
 *   container — stays compact (`{us: {ipa}}`, `{en: [ranges]}`), because
 *   its keys are the only structure there is;
 * - an object mixing primitives with containers is a reading record
 *   (`{en, cn, examples}`) and keeps its structured card;
 * - an array is compact when every item is;
 * - nothing larger than the fold threshold compacts — big groups keep
 *   their collapsible panel.
 */
export function isCompact(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true
  if (Array.isArray(value)) {
    if (value.length > LARGE_GROUP) return false
    return value.every(isCompact)
  }
  const entries = Object.entries(value)
  if (entries.length > LARGE_GROUP) return false
  const values = entries.map(([, entryValue]) => entryValue)
  const hasPrimitive = values.some((entryValue) => entryValue === null || typeof entryValue !== 'object')
  if (hasPrimitive) {
    // A record: scalars beside containers read as a structured card.
    return values.every((entryValue) => entryValue === null || typeof entryValue !== 'object')
  }
  // Pure grouping: the keys are the only structure, so one line suffices.
  return values.every(isCompact)
}
