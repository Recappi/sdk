/// <reference types="node" />

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import test from 'ava'

import sdk from '../index.cjs'

const require = createRequire(import.meta.url)
const linuxBackend = require('./linux-pulse-fixture.cjs') as {
  createPrivatePulseFixture: () => {
    rootDir: string
    runtimeDir: string
    sinkName: string
    monitorSource: string
    microphoneSource: string
    microphonePipePath: string
    cleanup: () => void
  }
  getLinuxPlatformCapabilities: (env?: NodeJS.ProcessEnv) => {
    applicationListing: boolean
    applicationLookup: boolean
    applicationListEvents: boolean
    applicationStateEvents: boolean
    microphoneState: boolean
    tapAudio: boolean
    tapGlobalAudio: boolean
  }
  loadNullSink: (
    env: NodeJS.ProcessEnv,
    sinkName?: string,
  ) => {
    sinkName: string
    monitorSource: string
    unload: () => void
  }
  readModules: (env?: NodeJS.ProcessEnv) => Array<{
    name: string
    argument: string
  }>
  startPrivatePulseServer: (fixture: {
    rootDir: string
    runtimeDir: string
    sinkName: string
    monitorSource: string
    microphoneSource: string
    microphonePipePath: string
  }) => {
    env: NodeJS.ProcessEnv
    stop: () => void
  }
  playSineTone: (env: NodeJS.ProcessEnv, sinkName: string, durationSeconds?: number, frequency?: number) => void
  startSineTonePlayer: (
    env: NodeJS.ProcessEnv,
    sinkName: string,
    durationSeconds?: number,
    frequency?: number,
  ) => {
    pid: number
    wait: () => Promise<void>
  }
  startSineToneToSource: (
    env: NodeJS.ProcessEnv,
    pipePath: string,
    durationSeconds?: number,
    frequency?: number,
  ) => {
    wait: () => Promise<void>
  }
}

function rememberEnv(keys: string[]) {
  const env = new Map<string, string | undefined>()
  for (const key of keys) {
    env.set(key, process.env[key])
  }
  return env
}

function restoreEnv(originalEnv: Map<string, string | undefined>) {
  for (const [key, value] of originalEnv.entries()) {
    if (typeof value === 'undefined') {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function withPrivatePulseRuntime<T>(
  callback: (ctx: {
    fixture: ReturnType<typeof linuxBackend.createPrivatePulseFixture>
    envKeys: string[]
  }) => Promise<T>,
) {
  const fixture = linuxBackend.createPrivatePulseFixture()
  const envKeys = ['HOME', 'PULSE_SINK', 'RECAPPI_PULSE_MONITOR_SOURCE', 'RECAPPI_PULSE_SOURCE', 'XDG_RUNTIME_DIR']
  const originalEnv = rememberEnv(envKeys)
  let server: ReturnType<typeof linuxBackend.startPrivatePulseServer> | null = null

  try {
    server = linuxBackend.startPrivatePulseServer(fixture)
    for (const [key, value] of Object.entries(server.env)) {
      if (typeof value === 'string') {
        process.env[key] = value
      }
    }

    return await callback({ fixture, envKeys })
  } finally {
    server?.stop()
    fixture.cleanup()
    restoreEnv(originalEnv)
  }
}

function mergeBuffers(buffers: Float32Array[]) {
  const merged = new Float32Array(buffers.reduce((length, chunk) => length + chunk.length, 0))
  let offset = 0
  for (const chunk of buffers) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function maxAmplitude(samples: Float32Array) {
  let amplitude = 0
  for (const sample of samples) {
    amplitude = Math.max(amplitude, Math.abs(sample))
  }
  return amplitude
}

function measureFrequencyMagnitude(samples: Float32Array, sampleRate: number, frequency: number) {
  const windowSize = Math.min(samples.length, 8192)
  const startIndex = Math.max(0, Math.floor((samples.length - windowSize) / 2))
  let real = 0
  let imaginary = 0

  for (let index = 0; index < windowSize; index += 1) {
    const sample = samples[startIndex + index]
    const angle = (2 * Math.PI * frequency * index) / sampleRate
    real += sample * Math.cos(angle)
    imaginary -= sample * Math.sin(angle)
  }

  return Math.sqrt(real * real + imaginary * imaginary) / windowSize
}

test.serial('linux capabilities should require capture tooling to be present', (t) => {
  if (process.platform !== 'linux') {
    t.pass()
    return
  }

  const originalPath = process.env.PATH

  try {
    process.env.PATH = dirname(process.execPath)
    const capabilities = sdk.getPlatformCapabilities()

    t.false(capabilities.applicationStateEvents)
    t.false(capabilities.microphoneState)
    t.false(capabilities.tapAudio)
    t.false(capabilities.tapGlobalAudio)
  } finally {
    if (typeof originalPath === 'undefined') {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  }
})

test.serial(
  'linux capture backend should report runtime-ready capabilities and capture audible monitor samples',
  async (t) => {
    if (process.platform !== 'linux') {
      t.pass()
      return
    }

    await withPrivatePulseRuntime(async ({ fixture }) => {
      let session: InstanceType<typeof sdk.AudioCaptureSession> | null = null
      let callbackError: Error | null = null
      const buffers: Float32Array[] = []

      try {
        process.env.RECAPPI_PULSE_SOURCE = fixture.monitorSource
        const capabilities = sdk.getPlatformCapabilities()
        t.true(capabilities.applicationListing)
        t.true(capabilities.applicationLookup)
        t.true(capabilities.applicationListEvents)
        t.true(capabilities.applicationStateEvents)
        t.true(capabilities.microphoneState)
        t.true(capabilities.tapAudio)
        t.true(capabilities.tapGlobalAudio)

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
        linuxBackend.playSineTone(process.env, fixture.sinkName, 2.5, 440)
        await delay(400)
        session.stop()
        await delay(200)

        t.is(callbackError, null)
        t.true(buffers.length > 0)

        const merged = mergeBuffers(buffers)
        t.true(merged.length >= 16_000)
      } finally {
        session?.stop()
      }
    })
  },
)

test.serial('linux capture backend should mix microphone and app audio when both are active', async (t) => {
  if (process.platform !== 'linux') {
    t.pass()
    return
  }

  await withPrivatePulseRuntime(async ({ fixture }) => {
    let session: InstanceType<typeof sdk.AudioCaptureSession> | null = null
    let callbackError: Error | null = null
    const buffers: Float32Array[] = []

    try {
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
      const microphoneTone = linuxBackend.startSineToneToSource(process.env, fixture.microphonePipePath, 2.5, 660)
      await delay(150)
      linuxBackend.playSineTone(process.env, fixture.sinkName, 2.5, 440)
      await microphoneTone.wait()
      await delay(400)
      session.stop()
      await delay(200)

      t.is(callbackError, null)
      t.true(buffers.length > 0)

      const merged = mergeBuffers(buffers)
      const amplitude = maxAmplitude(merged)
      const monitorMagnitude = measureFrequencyMagnitude(merged, 16_000, 440)
      const microphoneMagnitude = measureFrequencyMagnitude(merged, 16_000, 660)
      const offTargetMagnitude = measureFrequencyMagnitude(merged, 16_000, 1_000)

      t.true(merged.length >= 16_000)
      t.true(amplitude > 0.01)
      t.true(monitorMagnitude > offTargetMagnitude * 3)
      t.true(microphoneMagnitude > offTargetMagnitude * 3)
    } finally {
      session?.stop()
    }
  })
})

test.serial('linux tapGlobalAudio should honor excluded processes on the captured sink', async (t) => {
  if (process.platform !== 'linux') {
    t.pass()
    return
  }

  await withPrivatePulseRuntime(async ({ fixture }) => {
    let session: InstanceType<typeof sdk.AudioCaptureSession> | null = null
    let callbackError: Error | null = null
    const buffers: Float32Array[] = []

    try {
      process.env.RECAPPI_PULSE_SOURCE = fixture.monitorSource
      const includedTone = linuxBackend.startSineTonePlayer(process.env, fixture.sinkName, 3.5, 440)
      const excludedTone = linuxBackend.startSineTonePlayer(process.env, fixture.sinkName, 3.5, 880)
      const excludedApp = new sdk.ApplicationInfo(excludedTone.pid, 'excluded-tone', excludedTone.pid)

      await delay(200)
      session = sdk.ShareableContent.tapGlobalAudio([excludedApp], (err: Error | null, samples?: Float32Array) => {
        if (err) {
          callbackError = err
          return
        }

        if (samples && samples.length > 0) {
          buffers.push(samples)
        }
      })

      await Promise.all([includedTone.wait(), excludedTone.wait()])
      await delay(400)
      session.stop()
      await delay(200)

      t.is(callbackError, null)
      t.true(buffers.length > 0)

      const merged = mergeBuffers(buffers)
      const amplitude = maxAmplitude(merged)
      const includedMagnitude = measureFrequencyMagnitude(merged, 16_000, 440)
      const excludedMagnitude = measureFrequencyMagnitude(merged, 16_000, 880)
      const offTargetMagnitude = measureFrequencyMagnitude(merged, 16_000, 1_200)

      t.true(merged.length >= 16_000)
      t.true(amplitude > 0.01)
      t.true(includedMagnitude > offTargetMagnitude * 3)
      t.true(includedMagnitude > excludedMagnitude * 3)
    } finally {
      session?.stop()
    }
  })
})

test.serial('linux tapAudio should isolate the target process output via a dedicated Pulse sink', async (t) => {
  if (process.platform !== 'linux') {
    t.pass()
    return
  }

  await withPrivatePulseRuntime(async ({ fixture }) => {
    let session: InstanceType<typeof sdk.AudioCaptureSession> | null = null
    let callbackError: Error | null = null
    const buffers: Float32Array[] = []

    try {
      process.env.RECAPPI_PULSE_SOURCE = fixture.monitorSource
      const targetTone = linuxBackend.startSineTonePlayer(process.env, fixture.sinkName, 3.5, 440)
      t.true(targetTone.pid > 0)

      await delay(200)
      session = sdk.ShareableContent.tapAudio(targetTone.pid, (err: Error | null, samples?: Float32Array) => {
        if (err) {
          callbackError = err
          return
        }

        if (samples && samples.length > 0) {
          buffers.push(samples)
        }
      })

      await delay(400)
      const backgroundTone = linuxBackend.startSineTonePlayer(process.env, fixture.sinkName, 2.5, 880)
      await Promise.all([targetTone.wait(), backgroundTone.wait()])
      await delay(400)
      session.stop()
      await delay(200)

      t.is(callbackError, null)
      t.true(buffers.length > 0)

      const merged = mergeBuffers(buffers)
      const amplitude = maxAmplitude(merged)
      const targetMagnitude = measureFrequencyMagnitude(merged, 16_000, 440)
      const backgroundMagnitude = measureFrequencyMagnitude(merged, 16_000, 880)
      const offTargetMagnitude = measureFrequencyMagnitude(merged, 16_000, 1_200)

      t.true(merged.length >= 16_000)
      t.true(amplitude > 0.01)
      t.true(targetMagnitude > offTargetMagnitude * 3)
      t.true(targetMagnitude > backgroundMagnitude * 3)
    } finally {
      session?.stop()
    }
  })
})

test.serial('linux tapAudio should loop captured audio back to the source sink', async (t) => {
  if (process.platform !== 'linux') {
    t.pass()
    return
  }

  await withPrivatePulseRuntime(async ({ fixture }) => {
    let session: InstanceType<typeof sdk.AudioCaptureSession> | null = null
    let callbackError: Error | null = null
    const buffers: Float32Array[] = []
    const alternateSink = linuxBackend.loadNullSink(process.env)

    try {
      process.env.RECAPPI_PULSE_SOURCE = fixture.monitorSource
      const targetTone = linuxBackend.startSineTonePlayer(process.env, alternateSink.sinkName, 3.5, 440)

      await delay(200)
      session = sdk.ShareableContent.tapAudio(targetTone.pid, (err: Error | null, samples?: Float32Array) => {
        if (err) {
          callbackError = err
          return
        }

        if (samples && samples.length > 0) {
          buffers.push(samples)
        }
      })

      await delay(400)
      const loopbackModules = linuxBackend
        .readModules(process.env)
        .filter((module) => module.name === 'module-loopback')
      const captureSinkPrefix = `source=recappi_capture_${targetTone.pid}_${process.pid}_`
      const expectedLoopback = loopbackModules.find(
        (module) =>
          module.argument.includes(captureSinkPrefix) && module.argument.includes(`sink=${alternateSink.sinkName}`),
      )
      const wrongLoopback = loopbackModules.find(
        (module) => module.argument.includes(captureSinkPrefix) && module.argument.includes(`sink=${fixture.sinkName}`),
      )

      t.truthy(expectedLoopback)
      t.falsy(wrongLoopback)

      await targetTone.wait()
      await delay(300)
      session.stop()
      await delay(200)

      t.is(callbackError, null)
      t.true(buffers.length > 0)
    } finally {
      session?.stop()
      alternateSink.unload()
    }
  })
})
