# `@recappi/sdk`

[![CI](https://github.com/Recappi/sdk/actions/workflows/CI.yml/badge.svg)](https://github.com/Recappi/sdk/actions/workflows/CI.yml)

## Platform support

| Feature                                       | macOS | Windows | Linux (x64 GNU)                   |
| --------------------------------------------- | ----- | ------- | --------------------------------- |
| `decodeAudio` / `decodeAudioSync`             | Yes   | Yes     | Yes                               |
| `ShareableContent.applications()`             | Yes   | Yes     | Yes                               |
| `ShareableContent.applicationWithProcessId()` | Yes   | Yes     | Yes                               |
| `ShareableContent.onApplicationListChanged()` | Yes   | Yes     | Yes (polling)                     |
| `ShareableContent.isUsingMicrophone()`        | Yes   | Yes     | Yes (PulseAudio)                  |
| `ShareableContent.onAppStateChanged()`        | Yes   | Yes     | Yes (polling)                     |
| `ShareableContent.tapGlobalAudio()`           | Yes   | Yes     | Yes (PulseAudio monitor)          |
| `ShareableContent.tapAudio()`                 | Yes   | Yes     | Yes (best-effort global fallback) |

Published Linux artifacts currently target `x86_64-unknown-linux-gnu`. The
Linux implementation ships the same top-level `ShareableContent` surface as
macOS and Windows, but it uses a PulseAudio-compatible userspace and shells out
to `pactl` / `ffmpeg`, so capture requires those tools to be available at
runtime.

If your application needs to choose a Linux fallback backend dynamically, use
`getPlatformCapabilities()` instead of hard-coding platform checks. On Linux,
those booleans reflect the currently reachable runtime prerequisites for each
capture path, not just whether the functions are exported.

```typescript
import { getPlatformCapabilities } from '@recappi/sdk'

const capabilities = getPlatformCapabilities()

if (capabilities.tapGlobalAudio) {
  console.log('Use Recappi for realtime capture')
} else {
  console.log('Use your Linux-specific fallback backend')
}
```

## Usage

### Recording system audio

> Available on macOS, Windows, and Linux. Linux capture requires a
> PulseAudio-compatible server plus `pactl` and `ffmpeg`.

Both input and output devices are recording, mixed into a single audio stream.

```typescript
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
```

### Listing running applications

> Available on macOS, Windows, and Linux.

```typescript
import { ShareableContent } from '@recappi/sdk'

const apps = ShareableContent.applications()

for (const app of apps) {
  console.log(`Name: ${app.name}, PID: ${app.processId}`)
}
```

### Recording specific application

> Available on macOS, Windows, and Linux.
> On Linux and Windows, `tapAudio()` currently uses the same capture backend as
> `tapGlobalAudio()` and does not isolate a single process stream yet.

```typescript
import { ShareableContent } from '@recappi/sdk'

const apps = ShareableContent.applications()
const musicApp = apps.find((app) => app.name === 'Music')

if (musicApp) {
  const session = ShareableContent.tapAudio(musicApp.processId, (err, samples) => {
    if (err) {
      console.error('Error capturing audio:', err)
      return
    }
    // Process samples...
  })

  // Stop recording after 5 seconds
  setTimeout(() => {
    session.stop()
  }, 5000)
}
```

## Playground

```sh
yarn install
yarn build
yarn workspace playground dev:server
yarn workspace playground dev:web
```

## Local Linux Iteration From macOS

Use the bundled Docker environment to exercise the Linux backend locally from a
macOS workstation.

```sh
yarn test:linux:docker
```

If you want an interactive shell inside the same Linux image:

```sh
yarn dev:linux:docker
```

The Docker image installs Rust, Node.js, PulseAudio, `pactl`, and `ffmpeg`, so
the Linux binding tests can run without depending on the host machine.
