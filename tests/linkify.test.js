import { expect, test } from 'vitest'
import { hasLink, hrefFor, linkSegments } from '../src/lib/linkify'

const linksIn = (body) => linkSegments(body).filter((s) => s.type === 'link')

// --- the boundary: what may become an href ----------------------------------
// A message body is attacker-supplied. These are the cases that turn a chat
// bubble into script execution in an origin holding the session.

test('only http and https ever become a link', () => {
  for (const hostile of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://meera.bigadtruck.com/abc',
  ]) {
    expect(hrefFor(hostile), hostile).toBeNull()
    expect(linksIn(`look ${hostile} here`), hostile).toHaveLength(0)
  }
})

test('a scheme is never prepended to something that already has one', () => {
  // The bare-host convenience must not rescue a rejected scheme by gluing
  // https:// in front of it.
  expect(hrefFor('www.javascript:alert(1)')).toBeNull()
  expect(hasLink('javascript:alert(1)')).toBe(false)
})

test('an absurdly long body cannot build a giant href', () => {
  expect(hrefFor(`https://x.com/${'a'.repeat(4000)}`)).toBeNull()
})

test('a host with no dot is not linked', () => {
  expect(hrefFor('http://localhost:5173')).toBeNull()
  expect(hrefFor('https://intranet')).toBeNull()
})

// --- the feature: sharing a reel --------------------------------------------

test('a pasted reel link becomes one tappable link', () => {
  const url = 'https://www.instagram.com/reel/Cx4abcDEfGh/'
  const links = linksIn(`look at this ${url}`)
  expect(links).toHaveLength(1)
  expect(links[0].href).toBe(url)
  expect(links[0].value).toBe(url)
})

test('a bare www host is linked over https', () => {
  expect(hrefFor('www.instagram.com/reel/abc')).toBe('https://www.instagram.com/reel/abc')
})

test('query strings and fragments survive, sentence punctuation does not', () => {
  expect(linksIn('see https://x.com/a?b=1&c=2#top.')[0].href).toBe('https://x.com/a?b=1&c=2#top')
  expect(linksIn('(https://x.com/a)')[0].href).toBe('https://x.com/a')
  // ...but a bracket that is really part of the path is kept.
  expect(linksIn('https://x.com/a(b)')[0].href).toBe('https://x.com/a(b)')
})

test('several links in one message are each their own segment', () => {
  const segs = linkSegments('one https://a.com/1 two https://b.com/2 three')
  expect(segs.filter((s) => s.type === 'link').map((s) => s.value))
    .toEqual(['https://a.com/1', 'https://b.com/2'])
})

// --- the invariant the renderer depends on ----------------------------------

test('segments reproduce the body exactly, so no words can be dropped', () => {
  for (const body of [
    'plain text with no link at all',
    'https://x.com/a',
    'before https://x.com/a after',
    'trailing punctuation https://x.com/a.',
    '(https://x.com/a) and [https://y.com/b]',
    'javascript:alert(1) is not a link',
    'multi https://a.com/1 and https://b.com/2 end',
    '',
  ]) {
    expect(linkSegments(body).map((s) => s.value).join('')).toBe(body)
  }
})

test('a body with no link produces no link segments', () => {
  expect(hasLink('just a normal message')).toBe(false)
  expect(hasLink('e.g. something. a sentence.')).toBe(false)
})
