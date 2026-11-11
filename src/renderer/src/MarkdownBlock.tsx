import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReactNode } from 'react'

/**
 * One markdown link: never navigates in-app (navigation is hard-denied by
 * the window), it hands the url to the main process to open in the system
 * browser. The click is swallowed for anything the main process would
 * refuse — a dead anchor is quieter than a broken expectation.
 */
function SafeLink({ href, children }: { href?: string; children?: ReactNode }): ReactNode {
  return (
    <a
      href={href ?? '#'}
      data-md-link
      onClick={(event) => {
        event.preventDefault()
        if (href) window.jsonReader.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** Images never load from the network (the CSP keeps it that way); their
    alt text renders instead of a broken glyph. */
function AltImage({ alt }: { alt?: string }): ReactNode {
  return <span className="md-img">{alt ? `🖼 ${alt}` : '🖼'}</span>
}

/**
 * Renders markdown text as React elements — no innerHTML anywhere. Raw
 * HTML in the source is escaped, never executed, by react-markdown's
 * default. `wrapped` adds the reading-layout container; JSON values
 * render inline-unwrapped, file views wrapped.
 */
export function MarkdownBlock({ text, wrapped = false }: { text: string; wrapped?: boolean }): ReactNode {
  const content = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: SafeLink,
        img: AltImage
      }}
    >
      {text}
    </ReactMarkdown>
  )
  if (!wrapped) return content
  return <div className="md-preview">{content}</div>
}

export const MemoizedMarkdownBlock = memo(MarkdownBlock)
