import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownBlock } from './MarkdownBlock'

describe('MarkdownBlock', () => {
  it('renders headings, lists, code and tables', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownBlock, {
        text: '# Title\n\n- one\n- two\n\n```js\nconst x = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |'
      })
    )
    expect(markup).toContain('<h1>')
    expect(markup).toContain('<li>')
    expect(markup).toContain('<code')
    expect(markup).toContain('<table>')
  })

  it('does not render raw HTML from the source', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownBlock, { text: '<script>alert(1)</script>\n\n<div onclick="x()">hi</div>' })
    )
    // No real tags or attributes: the source survives as escaped text only.
    expect(markup).not.toContain('<script>')
    expect(markup).not.toContain('<div')
    expect(markup).not.toContain('onclick="x()"')
    expect(markup).toContain('&lt;script&gt;')
    expect(markup).toContain('&lt;div onclick=')
  })

  it('renders links as safe anchors handed to openExternal', () => {
    const markup = renderToStaticMarkup(createElement(MarkdownBlock, { text: 'see [the docs](https://example.com/docs)' }))
    expect(markup).toContain('<a ')
    expect(markup).toContain('href="https://example.com/docs"')
  })

  it('renders images as alt-text placeholders', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownBlock, { text: '![logo of the app](https://example.com/logo.png)' })
    )
    expect(markup).not.toContain('<img')
    expect(markup).toContain('logo of the app')
    expect(markup).toContain('md-img')
  })

  it('renders inline markdown without wrapping chrome', () => {
    const markup = renderToStaticMarkup(createElement(MarkdownBlock, { text: 'just a **bold** line' }))
    expect(markup).toContain('<strong>')
    expect(markup).not.toContain('md-preview')
  })

  it('renders wrapped with the preview class on demand', () => {
    const markup = renderToStaticMarkup(createElement(MarkdownBlock, { text: 'plain', wrapped: true }))
    expect(markup).toContain('md-preview')
  })
})
