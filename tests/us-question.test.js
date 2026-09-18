import { expect, test } from 'vitest'
import fs from 'node:fs'

const src = fs.readFileSync('src/components/UsPair.jsx', 'utf8')
const sql = fs.readFileSync('supabase/migrations/202609060001_audit_fixes.sql', 'utf8')

// The Us question card shipped unable to send, and it failed SILENTLY, which is
// why it looked like a dead button rather than an error.

test('the question is read from the same function the writer validates against', () => {
  // answer_daily_prompt checks the submitted id against todays_prompt(). The
  // client showed pair_prompt(), which picks from the pool on a different epoch
  // — CLAUDE.md records the two as 13 apart mod 30 — so every answer was
  // refused with "The daily question has changed".
  expect(sql).toMatch(/select id into today_prompt from public\.todays_prompt\(\)/)
  expect(src).toMatch(/getTodaysPrompt\(\)/)
  expect(src).not.toMatch(/getPairPrompt/)
})

test('a failed send is shown, never swallowed', () => {
  // `catch {}` around the send is what turned a raising RPC into a button that
  // appeared to do nothing at all.
  expect(src).toMatch(/setSendError\(/)
  expect(src).toMatch(/role="alert"/)
  expect(src).not.toMatch(/\}\s*catch\s*\{\s*\/\*[^}]*\*\/\s*\}\s*\n\s*finally \{ setSaving/)
})

test('a failed send keeps the draft', () => {
  // The sentence is the user's; losing it to a blip is the second injury.
  // Look at the catch BLOCK itself rather than the first 'catch' in the
  // function — the inner re-read has a .catch() of its own, which is what made
  // the first version of this test wrong.
  const block = src.slice(src.indexOf('} catch (err) {'), src.indexOf('} finally { setSaving'))
  expect(block).toContain('setSendError')
  expect(block).not.toContain("setAnswer('')")
})
