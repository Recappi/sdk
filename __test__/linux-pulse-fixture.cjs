const { spawn, spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_CHANNELS = 1
const PCM_BITS_PER_SAMPLE = 16
const PCM_BYTES_PER_SAMPLE = PCM_BITS_PER_SAMPLE / 8
const PCM_MAX_AMPLITUDE = Math.floor(0.25 * 0x7fff)
const LINUX_CAPTURE_ERROR_CODE = 'ERR_RECAPPI_LINUX_BACKEND'

function isCommandAvailable(command, env = process.env) {
  const result = spawnSync(
    '/bin/sh',
    ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`],
    {
      env,
      stdio: 'ignore',
    },
  )

  return result.status === 0
}

function createLinuxBackendError(feature, detail) {
  const suffix = detail ? ` ${detail}` : ''
  const error = new Error(`${feature} requires Linux audio test tooling (pactl, PulseAudio utilities, and an available Pulse server).${suffix}`)
  error.code = LINUX_CAPTURE_ERROR_CODE
  return error
}

function createProcessError(command, args, result) {
  if (result.error) {
    return createLinuxBackendError(command, `Failed to start "${command} ${args.join(' ')}": ${result.error.message}`)
  }

  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  return createLinuxBackendError(
    command,
    `Command "${command} ${args.join(' ')}" exited with ${result.status}.${stderr ? ` ${stderr}` : stdout ? ` ${stdout}` : ''}`,
  )
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })

  if (result.status !== 0 || result.error) {
    throw createProcessError(command, args, result)
  }

  return (result.stdout || '').trim()
}

function buildTempAudioPath(prefix, extension) {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`)
}

function createSinePcmBuffer(
  durationSeconds = 2.5,
  frequency = 440,
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = DEFAULT_CHANNELS,
) {
  const frameCount = Math.max(1, Math.floor(durationSeconds * sampleRate))
  const pcmBuffer = Buffer.alloc(frameCount * channels * PCM_BYTES_PER_SAMPLE)

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const radians = (2 * Math.PI * frequency * frameIndex) / sampleRate
    const sample = Math.round(Math.sin(radians) * PCM_MAX_AMPLITUDE)

    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const offset = (frameIndex * channels + channelIndex) * PCM_BYTES_PER_SAMPLE
      pcmBuffer.writeInt16LE(sample, offset)
    }
  }

  return pcmBuffer
}

function createWavBuffer(
  pcmBuffer,
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = DEFAULT_CHANNELS,
) {
  const blockAlign = channels * PCM_BYTES_PER_SAMPLE
  const byteRate = sampleRate * blockAlign
  const wavBuffer = Buffer.alloc(44 + pcmBuffer.length)

  wavBuffer.write('RIFF', 0)
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4)
  wavBuffer.write('WAVE', 8)
  wavBuffer.write('fmt ', 12)
  wavBuffer.writeUInt32LE(16, 16)
  wavBuffer.writeUInt16LE(1, 20)
  wavBuffer.writeUInt16LE(channels, 22)
  wavBuffer.writeUInt32LE(sampleRate, 24)
  wavBuffer.writeUInt32LE(byteRate, 28)
  wavBuffer.writeUInt16LE(blockAlign, 32)
  wavBuffer.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34)
  wavBuffer.write('data', 36)
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40)
  pcmBuffer.copy(wavBuffer, 44)

  return wavBuffer
}

function writeSineToneWavFile(durationSeconds = 2.5, frequency = 440) {
  const wavPath = buildTempAudioPath(`recappi-tone-${frequency}`, 'wav')
  writeFileSync(wavPath, createWavBuffer(createSinePcmBuffer(durationSeconds, frequency)))
  return wavPath
}

function writeSineToneRawFile(durationSeconds = 2.5, frequency = 660) {
  const rawPath = buildTempAudioPath(`recappi-source-${frequency}`, 's16le')
  writeFileSync(rawPath, createSinePcmBuffer(durationSeconds, frequency))
  return rawPath
}

function readPulseInfo(env = process.env) {
  const output = runCommand('pactl', ['info'], { env })
  const info = {}

  for (const line of output.split('\n')) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    info[key] = value
  }

  return {
    defaultSink: info['Default Sink'] || '',
    defaultSource: info['Default Source'] || '',
  }
}

function canReadPulseInfo(env = process.env) {
  try {
    readPulseInfo(env)
    return true
  } catch {
    return false
  }
}

function canResolveMonitorSource(env = process.env) {
  try {
    return Boolean(resolveMonitorSource(env))
  } catch {
    return false
  }
}

function getLinuxPlatformCapabilities(env = process.env) {
  const hasPs = isCommandAvailable('ps', env)
  const hasPactl = isCommandAvailable('pactl', env)
  const hasFfmpeg = isCommandAvailable('ffmpeg', env)
  const pulseRuntimeReady = hasPactl && canReadPulseInfo(env)
  const captureRuntimeReady = pulseRuntimeReady && hasFfmpeg && canResolveMonitorSource(env)

  return {
    applicationListing: hasPs,
    applicationLookup: hasPs,
    applicationListEvents: hasPs,
    applicationStateEvents: pulseRuntimeReady,
    microphoneState: pulseRuntimeReady,
    tapAudio: captureRuntimeReady,
    tapGlobalAudio: captureRuntimeReady,
  }
}

function resolveMonitorSource(env = process.env) {
  const explicitMonitor = (env.RECAPPI_PULSE_MONITOR_SOURCE || '').trim()
  if (explicitMonitor) {
    return explicitMonitor
  }

  const { defaultSink } = readPulseInfo(env)
  if (!defaultSink) {
    throw createLinuxBackendError('ShareableContent.tapGlobalAudio', 'PulseAudio did not report a default sink.')
  }

  return `${defaultSink}.monitor`
}

function createPrivatePulseFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'recappi-linux-pulse-'))
  const runtimeDir = join(rootDir, 'runtime')
  const sinkName = `recappi_sink_${process.pid}`
  const microphoneSource = `recappi_mic_${process.pid}`
  const microphonePipePath = join(rootDir, 'mic.pipe')

  return {
    rootDir,
    runtimeDir,
    sinkName,
    monitorSource: `${sinkName}.monitor`,
    microphoneSource,
    microphonePipePath,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

function waitForChildProcess(childProcess, feature, describeFailure, cleanup) {
  return new Promise((resolve, reject) => {
    const finishCleanup = () => {
      cleanup?.()
    }

    if (childProcess.exitCode !== null) {
      finishCleanup()
      if (childProcess.exitCode === 0) {
        resolve()
      } else {
        reject(createLinuxBackendError(feature, describeFailure(childProcess.exitCode)))
      }
      return
    }

    childProcess.once('error', (error) => {
      finishCleanup()
      reject(createLinuxBackendError(feature, `Failed to launch ${feature} helper: ${error.message}`))
    })

    childProcess.once('close', (code) => {
      finishCleanup()
      if (code === 0) {
        resolve()
        return
      }

      reject(createLinuxBackendError(feature, describeFailure(code)))
    })
  })
}

function startPrivatePulseServer(fixture) {
  const env = {
    ...process.env,
    HOME: fixture.rootDir,
    XDG_RUNTIME_DIR: fixture.runtimeDir,
  }

  mkdirSync(fixture.runtimeDir, { recursive: true, mode: 0o700 })
  runCommand(
    'pulseaudio',
    ['--daemonize=yes', '--exit-idle-time=-1', '--log-target=stderr'],
    { env },
  )
  const sinkModuleId = runCommand(
    'pactl',
    ['load-module', 'module-null-sink', `sink_name=${fixture.sinkName}`],
    { env },
  )
  const sourceModuleId = runCommand(
    'pactl',
    [
      'load-module',
      'module-pipe-source',
      `source_name=${fixture.microphoneSource}`,
      `file=${fixture.microphonePipePath}`,
      `rate=${DEFAULT_SAMPLE_RATE}`,
      `channels=${DEFAULT_CHANNELS}`,
      'format=s16le',
    ],
    { env },
  )
  runCommand('pactl', ['set-default-sink', fixture.sinkName], { env })
  runCommand('pactl', ['set-default-source', fixture.microphoneSource], { env })

  return {
    env: {
      HOME: fixture.rootDir,
      XDG_RUNTIME_DIR: fixture.runtimeDir,
      PULSE_SINK: fixture.sinkName,
      RECAPPI_PULSE_MONITOR_SOURCE: fixture.monitorSource,
      RECAPPI_PULSE_SOURCE: fixture.microphoneSource,
    },
    stop() {
      try {
        runCommand('pactl', ['unload-module', sourceModuleId], { env })
      } catch {
        // Ignore teardown issues so tests can clean up best-effort.
      }

      try {
        runCommand('pactl', ['unload-module', sinkModuleId], { env })
      } catch {
        // Ignore teardown issues so tests can clean up best-effort.
      }

      spawnSync('pulseaudio', ['--kill'], {
        env,
        stdio: 'ignore',
      })
    },
  }
}

function loadNullSink(env, sinkName = `recappi_extra_sink_${process.pid}_${Date.now()}`) {
  const moduleId = runCommand('pactl', ['load-module', 'module-null-sink', `sink_name=${sinkName}`], { env })

  return {
    sinkName,
    monitorSource: `${sinkName}.monitor`,
    unload() {
      try {
        runCommand('pactl', ['unload-module', moduleId], { env })
      } catch {
        // Best-effort test cleanup.
      }
    },
  }
}

function readModules(env = process.env) {
  const output = runCommand('pactl', ['list', 'modules'], { env })
  const sections = output.split(/\n(?=Module #)/)

  return sections
    .map((section) => {
      const nameMatch = section.match(/^\s*Name:\s+(.+)$/m)
      if (!nameMatch) {
        return null
      }

      const argumentMatch = section.match(/^\s*Argument:\s*(.*)$/m)
      return {
        name: nameMatch[1].trim(),
        argument: argumentMatch ? argumentMatch[1].trim() : '',
      }
    })
    .filter(Boolean)
}

function playSineTone(env, sinkName, durationSeconds = 2.5, frequency = 440) {
  const wavPath = writeSineToneWavFile(durationSeconds, frequency)

  try {
    runCommand('paplay', ['--device', sinkName, wavPath], { env })
  } finally {
    rmSync(wavPath, { force: true })
  }
}

function startSineTonePlayer(env, sinkName, durationSeconds = 2.5, frequency = 440) {
  const wavPath = writeSineToneWavFile(durationSeconds, frequency)

  const paplayProc = spawn('paplay', ['--device', sinkName, wavPath], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  let stderrBuffer = ''
  paplayProc.stderr.on('data', (chunk) => {
    stderrBuffer += String(chunk)
  })

  return {
    pid: paplayProc.pid ?? 0,
    process: paplayProc,
    wait() {
      return waitForChildProcess(
        paplayProc,
        'ShareableContent.tapAudio',
        (code) => stderrBuffer.trim() || `paplay exited with ${code}`,
        () => {
          rmSync(wavPath, { force: true })
        },
      )
    },
  }
}

function startSineToneToSource(
  env,
  pipePath,
  durationSeconds = 2.5,
  frequency = 660,
) {
  const rawPath = writeSineToneRawFile(durationSeconds, frequency)
  const writerProc = spawn(
    process.execPath,
    [
      '-e',
      `
const { createReadStream, createWriteStream, rmSync } = require('node:fs')
const { pipeline } = require('node:stream')

const cleanup = () => {
  try {
    rmSync(process.env.RECAPPI_TONE_SOURCE_PATH, { force: true })
  } catch {}
}

pipeline(
  createReadStream(process.env.RECAPPI_TONE_SOURCE_PATH),
  createWriteStream(process.env.RECAPPI_TONE_PIPE_PATH),
  (error) => {
    cleanup()
    if (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  },
)
      `,
    ],
    {
      env: {
        ...env,
        RECAPPI_TONE_PIPE_PATH: pipePath,
        RECAPPI_TONE_SOURCE_PATH: rawPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )

  let stderrBuffer = ''
  writerProc.stderr.on('data', (chunk) => {
    stderrBuffer += String(chunk)
  })

  return {
    process: writerProc,
    wait() {
      return waitForChildProcess(
        writerProc,
        'ShareableContent.tapGlobalAudio',
        (code) => stderrBuffer.trim() || `node source writer exited with ${code}`,
        () => {
          rmSync(rawPath, { force: true })
        },
      )
    },
  }
}

module.exports = {
  createPrivatePulseFixture,
  getLinuxPlatformCapabilities,
  loadNullSink,
  readModules,
  startPrivatePulseServer,
  playSineTone,
  startSineTonePlayer,
  startSineToneToSource,
  LINUX_CAPTURE_ERROR_CODE,
}
