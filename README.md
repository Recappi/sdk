# `@recappi/sdk`

[![CI](https://github.com/Recappi/sdk/actions/workflows/CI.yml/badge.svg)](https://github.com/Recappi/sdk/actions/workflows/CI.yml)

## Usage

### Recording system audio

Both input and output devices are recording, mixed into a single audio stream.

```ts
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { ShareableContent } from "@recappi/sdk";
import { createWavBuffer } from "@recappi/sdk/encode-wav";

const WavBuffers = [];

let totalLength = 0;

const session = ShareableContent.tapGlobalAudio([], (err, samples) => {
  if (err) {
    console.error("Error capturing audio:", err);
    return;
  }
  WavBuffers.push(samples);
  totalLength += samples.length;
});

console.info("Recording audio for 5 seconds...");

await setTimeout(5000); // Record for 5 seconds

session.stop();

console.info(
  `Recording stopped. Writing ${totalLength} samples to output.wav...`,
);

const { buf: contactedBuffer } = WavBuffers.reduce(
  ({ buf, offset }, cur) => {
    buf.set(cur, offset);
    return {
      buf,
      offset: offset + cur.length,
    };
  },
  {
    buf: new Float32Array(totalLength),
    offset: 0,
  },
);

console.log(`Creating WAV buffer ...`);

const wavBuffer = Buffer.from(
  createWavBuffer(contactedBuffer, {
    sampleRate: session.sampleRate,
    numChannels: session.channels,
  }),
);

await writeFile("output.wav", wavBuffer);
```

### Listing running applications

```ts
import { ShareableContent } from "@recappi/sdk";

const apps = ShareableContent.applications();

for (const app of apps) {
  console.log(`Name: ${app.name}, PID: ${app.processId}`);
}
```

### Recording specific application

```ts
import { ShareableContent } from "@recappi/sdk";

const apps = ShareableContent.applications();
const musicApp = apps.find((app) => app.name === "Music");

if (musicApp) {
  const session = ShareableContent.tapAudio(
    musicApp.processId,
    (err, samples) => {
      if (err) {
        console.error("Error capturing audio:", err);
        return;
      }
      // Process samples...
    },
  );

  // Stop recording after 5 seconds
  setTimeout(() => {
    session.stop();
  }, 5000);
}
```

## Playground

```sh
yarn install
yarn build
yarn workspace playground dev:server
yarn workspace playground dev:web
```
