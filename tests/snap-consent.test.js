import { beforeEach, expect, test, vi } from 'vitest'

// The sender's permission, at the data layer. The half that had been wrong for
// months was a one-line predicate, so it gets a truth table rather than a
// happy-path test.
const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  prefRow: vi.fn(),
  rpc: vi.fn(),
  upload: vi.fn(),
}))

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: () => ({ upload: mocks.upload, createSignedUrl: vi.fn() }) },
    from: (table) => ({
      insert: (row) => { mocks.insert(row); return { select: () => ({ single: mocks.single }) } },
      select: () => {
        const q = { eq: () => q, maybeSingle: table === 'snap_save_prefs' ? mocks.prefRow : mocks.maybeSingle }
        return q
      },
    }),
  },
}))
vi.mock('../src/lib/image', () => ({ downscaleImage: async (b) => b, makeThumbnail: async () => null }))
vi.mock('../src/lib/push', () => ({ notify: vi.fn() }))

import {
  canExportToDevice,
  forgetSnapSaveDefault,
  clearSnapSaveDefaults,
  getSnapSaveDefault,
  sendSnap,
} from '../src/lib/db'

const ME = 'a', THEM = 'b' // 'a' < 'b', so ME is user_a under pairKey
const snap = (over = {}) => ({ id: 'm1', kind: 'snap', sender_id: THEM, saved_by: [], ...over })

beforeEach(() => {
  vi.clearAllMocks()
  clearSnapSaveDefaults()
  mocks.rpc.mockResolvedValue({})
  mocks.upload.mockResolvedValue({})
  mocks.single.mockResolvedValue({ data: { id: 'x' } })
  mocks.maybeSingle.mockResolvedValue({ data: null })
  mocks.prefRow.mockResolvedValue({ data: null })
})

// --------------------------------------------------------------------------
// canExportToDevice — the one definition
// --------------------------------------------------------------------------

test('a recipient cannot grant themselves the export by saving the snap', () => {
  // THE regression. SnapViewer's gate was `isMine || saved_by.includes(me)`,
  // and `toggle_saved()` may be called by EITHER party — so the recipient
  // tapped "Save in chat", their own uid landed in the array, and the viewer
  // handed them the download. The comment above it claimed the opposite.
  expect(canExportToDevice(snap({ saved_by: [ME], allow_save: false }), ME)).toBe(false)
})

test('the sender saying so at compose time is what opens it', () => {
  expect(canExportToDevice(snap({ allow_save: true }), ME)).toBe(true)
})

test('a mutual save opens it, and one side alone does not', () => {
  // Both parties saving IS a sender signal — the sender's half cannot be
  // written by anyone but the sender (guard_message_update).
  expect(canExportToDevice(snap({ saved_by: [THEM, ME] }), ME)).toBe(true)
  expect(canExportToDevice(snap({ saved_by: [THEM] }), ME)).toBe(false)
  expect(canExportToDevice(snap({ saved_by: [ME] }), ME)).toBe(false)
})

test('your own media is always yours', () => {
  expect(canExportToDevice(snap({ sender_id: ME, saved_by: [] }), ME)).toBe(true)
})

test('a row from before the migration is a no, not an unknown to resolve generously', () => {
  // No `allow_save` key at all. Consent is an act; its absence is a refusal.
  const legacy = { id: 'm', kind: 'snap', sender_id: THEM, saved_by: [ME] }
  expect(canExportToDevice(legacy, ME)).toBe(false)
  expect(canExportToDevice(null, ME)).toBe(false)
  expect(canExportToDevice(snap(), null)).toBe(false)
})

// --------------------------------------------------------------------------
// the send path stamps the answer onto the row
// --------------------------------------------------------------------------

const sent = () => mocks.insert.mock.calls.at(-1)[0]
const blob = () => new Blob(['x'], { type: 'image/jpeg' })

test('an explicit answer is carried onto the message, both ways', async () => {
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, allowSave: true, clientId: 'c1' })
  expect(sent().allow_save).toBe(true)
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, allowSave: false, clientId: 'c2' })
  expect(sent().allow_save).toBe(false)
})

test('no explicit answer falls back to the pair default, and the default needs BOTH halves', async () => {
  mocks.prefRow.mockResolvedValue({ data: { user_a: ME, user_b: THEM, a_allows: true, b_allows: true } })
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, clientId: 'c3' })
  expect(sent().allow_save).toBe(true)

  clearSnapSaveDefaults()
  mocks.prefRow.mockResolvedValue({ data: { user_a: ME, user_b: THEM, a_allows: true, b_allows: false } })
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, clientId: 'c4' })
  // One person opting in is not the pair opting in. The other half is theirs.
  expect(sent().allow_save).toBe(false)
})

test('a failed lookup sends with saving OFF rather than failing the send', async () => {
  mocks.prefRow.mockResolvedValue({ error: new Error('offline') })
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, clientId: 'c5' })
  expect(sent().allow_save).toBe(false)
  expect(mocks.insert).toHaveBeenCalled() // the snap still went
})

test('the pair default is fetched once per pair, and a change forgets it', async () => {
  // The camera sends one photo to several friends in a loop; a round trip per
  // recipient before each send is a visible stall.
  mocks.prefRow.mockResolvedValue({ data: { user_a: ME, user_b: THEM, a_allows: true, b_allows: true } })
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, clientId: 'c6' })
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, clientId: 'c7' })
  expect(mocks.prefRow).toHaveBeenCalledTimes(1)

  forgetSnapSaveDefault(ME, THEM)
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, clientId: 'c8' })
  expect(mocks.prefRow).toHaveBeenCalledTimes(2)
})

test('a database still missing the column drops the flag instead of failing the send', async () => {
  // The bundle can ship before 202609140033 is applied. Degrading has to go
  // toward LESS permission: the row lands on the column default, false.
  mocks.single
    .mockResolvedValueOnce({ error: new Error(`column "allow_save" of relation "messages" does not exist`) })
    .mockResolvedValueOnce({ data: { id: 'x' } })
  await sendSnap(ME, THEM, { blob: blob(), viewSeconds: 10, allowSave: true, clientId: 'c9' })
  expect(mocks.insert).toHaveBeenCalledTimes(2)
  expect('allow_save' in mocks.insert.mock.calls[0][0]).toBe(true)
  expect('allow_save' in mocks.insert.mock.calls[1][0]).toBe(false)
})

// --------------------------------------------------------------------------
// reading the pair default
// --------------------------------------------------------------------------

test('each side reads its own half, and no row means nobody has opted in', async () => {
  mocks.prefRow.mockResolvedValue({ data: { user_a: ME, user_b: THEM, a_allows: true, b_allows: false } })
  expect(await getSnapSaveDefault(ME, THEM)).toEqual({ mine: true, theirs: false, active: false })
  expect(await getSnapSaveDefault(THEM, ME)).toEqual({ mine: false, theirs: true, active: false })

  mocks.prefRow.mockResolvedValue({ data: null })
  expect(await getSnapSaveDefault(ME, THEM)).toEqual({ mine: false, theirs: false, active: false })
})

test('a failed read throws rather than answering "off"', async () => {
  // Rendering "off" from a failure is a claim about someone's privacy that the
  // app has not actually checked. The caller decides what "we do not know"
  // looks like; this layer refuses to invent an answer.
  mocks.prefRow.mockResolvedValue({ error: new Error('network') })
  await expect(getSnapSaveDefault(ME, THEM)).rejects.toThrow('network')
})
