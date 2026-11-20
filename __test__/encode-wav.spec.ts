import { createWavBuffer } from '@recappi/sdk/encode-wav'
import test from 'ava'

function readAscii(view: DataView, offset: number, length: number): string {
  let result = ''
  for (let i = 0; i < length; i++) {
    result += String.fromCharCode(view.getUint8(offset + i))
  }
  return result
}

test('should export createWavBuffer from @recappi/sdk/encode-wav', (t) => {
  t.is(typeof createWavBuffer, 'function')
})

test('should write valid WAV headers and PCM16 clamped samples', (t) => {
  const samples = new Float32Array([0, 1, -1, 0.5, -0.5, 1.5, -1.5, 0.25])
  const sampleRate = 48000
  const numChannels = 2
  const buffer = createWavBuffer(samples, { sampleRate, numChannels })

  t.true(buffer instanceof ArrayBuffer)

  const blockAlign = numChannels * 2
  const expectedDataSize = samples.length * 2
  t.is(expectedDataSize % blockAlign, 0)
  t.is(buffer.byteLength, 44 + expectedDataSize)

  const view = new DataView(buffer)

  // RIFF chunk descriptor
  t.is(readAscii(view, 0, 4), 'RIFF')
  t.is(view.getUint32(4, true), 36 + expectedDataSize)
  t.is(readAscii(view, 8, 4), 'WAVE')

  // fmt sub-chunk
  t.is(readAscii(view, 12, 4), 'fmt ')
  t.is(view.getUint32(16, true), 16)
  t.is(view.getUint16(20, true), 1) // PCM
  t.is(view.getUint16(22, true), numChannels)
  t.is(view.getUint32(24, true), sampleRate)
  t.is(view.getUint32(28, true), sampleRate * blockAlign) // byte rate
  t.is(view.getUint16(32, true), blockAlign) // block align
  t.is(view.getUint16(34, true), 16) // bits per sample

  // data sub-chunk
  t.is(readAscii(view, 36, 4), 'data')
  t.is(view.getUint32(40, true), expectedDataSize)

  // PCM16 samples with clamping
  const decoded = Array.from({ length: samples.length }, (_, i) => view.getInt16(44 + i * 2, true))
  t.deepEqual(decoded, [0, 32767, -32768, 16383, -16384, 32767, -32768, 8191])
})
