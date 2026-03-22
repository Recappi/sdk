import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

import test from 'ava'

import sdk from '../index.cjs'

const require = createRequire(import.meta.url)
const linuxBackend = require('../linux-shareable-content.cjs') as {
  createPrivatePulseFixture: () => {
    rootDir: string
    runtimeDir: string
    sinkName: string
    monitorSource: string
    cleanup: () => void
  }
  startPrivatePulseServer: (fixture: {
    rootDir: string
    runtimeDir: string
    sinkName: string
    monitorSource: string
  }) => {
    env: NodeJS.ProcessEnv
    stop: () => void
  }
  playSineTone: (env: NodeJS.ProcessEnv, sinkName: string, durationSeconds?: number) => void
}

test('linux capture backend should capture audible samples from a Pulse monitor source', async (t) => {
  if (process.platform !== 'linux') {
    t.pass()
    return
  }

  const fixture = linuxBackend.createPrivatePulseFixture()
  const originalEnv = new Map<string, string | undefined>()
  const envKeys = ['HOME', 'PULSE_SINK', 'RECAPPI_PULSE_MONITOR_SOURCE', 'XDG_RUNTIME_DIR']
  for (const key of envKeys) {
    originalEnv.set(key, process.env[key])
  }

  let server: ReturnType<typeof linuxBackend.startPrivatePulseServer> | null = null
  let session: InstanceType<typeof sdk.AudioCaptureSession> | null = null
  let callbackError: Error | null = null
  const buffers: Float32Array[] = []

  try {
    server = linuxBackend.startPrivatePulseServer(fixture)
    for (const [key, value] of Object.entries(server.env)) {
      if (typeof value === 'string') {
        process.env[key] = value
      }
    }

    session = sdk.ShareableContent.tapGlobalAudio(null, (err: Error | null, samples?: Float32Array) => {
      if (err) {
        callbackError = err
        return
      }

      if (samples && samples.length > 0) {
        buffers.push(samples)
      }
    })

    await delay(300)
    linuxBackend.playSineTone(process.env, fixture.sinkName, 2.5)
    await delay(400)
    session.stop()
    await delay(200)

    t.is(callbackError, null)
    t.true(buffers.length > 0)

    const merged = new Float32Array(buffers.reduce((length, chunk) => length + chunk.length, 0))
    let offset = 0
    for (const chunk of buffers) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    let maxAmplitude = 0
    for (const sample of merged) {
      maxAmplitude = Math.max(maxAmplitude, Math.abs(sample))
    }

    t.true(merged.length >= 16_000)
    t.true(maxAmplitude > 0.01)
  } finally {
    session?.stop()
    server?.stop()
    fixture.cleanup()

    for (const [key, value] of originalEnv.entries()) {
      if (typeof value === 'undefined') {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})
