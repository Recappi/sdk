import { writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

import { ShareableContent } from '@recappi/sdk'
import { createWavBuffer } from '@recappi/sdk/encode-wav'

const WavBuffers = []

let totalLength = 0

const session = ShareableContent.tapGlobalAudio([], (err, samples) => {
  if (err) {
    console.error('Error capturing audio:', err)
    return
  }
  WavBuffers.push(samples)
  totalLength += samples.length
})

console.info('Recording audio for 5 seconds...')

await setTimeout(5000) // Record for 5 seconds

session.stop()

console.info(`Recording stopped. Writing ${totalLength} samples to output.wav...`)

const { buf: contactedBuffer } = WavBuffers.reduce(
  ({ buf, offset }, cur) => {
    buf.set(cur, offset)
    return {
      buf,
      offset: offset + cur.length,
    }
  },
  {
    buf: new Float32Array(totalLength),
    offset: 0,
  },
)

console.log(`Creating WAV buffer ...`)

const wavBuffer = Buffer.from(
  createWavBuffer(contactedBuffer, {
    sampleRate: session.sampleRate,
    numChannels: session.channels,
  }),
)

await writeFile('output.wav', wavBuffer)
