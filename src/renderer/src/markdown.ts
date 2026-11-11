/**
 * A cheap structural probe: does this text carry markdown structure worth
 * rendering? Line-anchored patterns keep plain sentences with dashes or
 * asterisks from tripping the detector; one positive line is enough.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false
  return (
    /^#{1,6} \S/m.test(text) || // heading
    /^```/m.test(text) || // fenced code
    /^([-*+]|\d+[.)]) \S/m.test(text) || // bullet or ordered list
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text) || // link
    /\*\*[^*\n]+\*\*/.test(text) || // paired bold
    /^\|.+\|/m.test(text) || // table row
    /^> /m.test(text) // blockquote
  )
}
