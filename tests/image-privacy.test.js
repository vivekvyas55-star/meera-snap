import { afterEach, expect, test, vi } from 'vitest'
import { downscaleImage } from '../src/lib/image'
vi.mock('../src/lib/telemetry', () => ({ record: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
test('small photos are re-encoded even when their output is larger', async () => {
 const close = vi.fn()
 vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 10, close })))
 const clean = new Blob(['clean pixels without EXIF'], { type: 'image/jpeg' })
 vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage:vi.fn()})
 vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) { cb(clean) })
 const original = new Blob(['GPS'], { type: 'image/jpeg' })
 expect(await downscaleImage(original)).toBe(clean)
 expect(close).toHaveBeenCalled()
})
test('failed photo decoding never falls back to uploading the original', async () => {
 vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('bad photo') }))
 await expect(downscaleImage(new Blob(['GPS'], {type:'image/jpeg'}))).rejects.toThrow('safely')
})
