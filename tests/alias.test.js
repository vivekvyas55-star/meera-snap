import { describe, expect, it } from 'vitest'
import { currentAlias, matchesSearch } from '../src/lib/alias'

// The chat list's search box used to test the CURRENT alias and nothing else.
// Aliases rotate every thirty minutes, so "does searching for my girlfriend
// find her" had a different answer depending on the time of day.
describe('matchesSearch', () => {
  const sneha = { id: 'u1', username: 'sneha', display_name: 'Sneha' }

  it('finds someone by the handle and name you actually know them by', () => {
    // "S5" is a real alias this profile rotates through; while it is showing,
    // neither of these searches matched anything at all.
    expect(matchesSearch(sneha, 'sneha', 'S5')).toBe(true)
    expect(matchesSearch(sneha, 'Sneh', 'S5')).toBe(true)
  })

  it('still matches whichever alias is on screen', () => {
    expect(matchesSearch(sneha, 's5', 'S5')).toBe(true)
    const showing = currentAlias(sneha, 0)
    expect(matchesSearch(sneha, showing.toLowerCase(), showing)).toBe(true)
  })

  it('matches nobody on a term none of their names contain', () => {
    expect(matchesSearch(sneha, 'vivek', 'S5')).toBe(false)
  })

  it('treats an empty or whitespace query as no filter', () => {
    expect(matchesSearch(sneha, '', 'S5')).toBe(true)
    expect(matchesSearch(sneha, '   ', 'S5')).toBe(true)
    expect(matchesSearch(sneha, undefined, 'S5')).toBe(true)
  })

  it('survives a profile with missing names rather than throwing', () => {
    expect(matchesSearch({ id: 'x' }, 'anything', undefined)).toBe(false)
    expect(matchesSearch(null, '', null)).toBe(true)
  })
})
