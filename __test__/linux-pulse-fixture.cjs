const { spawn, spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readlinkSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setInterval, clearInterval, setTimeout } = require('node:timers')

const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_CHANNELS = 1
const POLL_INTERVAL_MS = 1_000
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
  const error = new Error(
    `${feature} requires PulseAudio-compatible tooling on Linux (pactl, ffmpeg, and an available Pulse server).${suffix}`,
  )
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

function parseLinuxProcessList() {
  const output = runCommand('ps', ['-eo', 'pid=,pgid=,comm='])

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) {
        return null
      }

      const [, pid, processGroupId, name] = match
      return new ApplicationInfo(Number(pid), name.trim(), Number(pid), {
        processGroupId: Number(processGroupId),
      })
    })
    .filter(Boolean)
}

function readExecutablePath(processId) {
  try {
    return readlinkSync(`/proc/${processId}/exe`)
  } catch {
    return ''
  }
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

function readSourceOutputs(env = process.env) {
  try {
    const jsonOutput = runCommand('pactl', ['--format=json', 'list', 'source-outputs'], { env })
    const parsed = JSON.parse(jsonOutput)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // Fall through to the plain-text parser for older pactl versions.
  }

  const textOutput = runCommand('pactl', ['list', 'source-outputs'], { env })
  const sections = textOutput.split(/\n(?=Source Output #)/)

  return sections
    .map((section) => {
      const processIdMatch = section.match(/application\.process\.id = "(\d+)"/)
      if (!processIdMatch) {
        return null
      }
      const sourceMatch = section.match(/^\s*Source:\s+(\d+)$/m)

      return {
        source: sourceMatch ? Number(sourceMatch[1]) : undefined,
        properties: {
          'application.process.id': processIdMatch[1],
        },
      }
    })
    .filter(Boolean)
}

function readSources(env = process.env) {
  try {
    const jsonOutput = runCommand('pactl', ['--format=json', 'list', 'sources'], { env })
    const parsed = JSON.parse(jsonOutput)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // Fall through to the plain-text parser for older pactl versions.
  }

  const textOutput = runCommand('pactl', ['list', 'sources'], { env })
  const sections = textOutput.split(/\n(?=Source #)/)

  return sections
    .map((section) => {
      const indexMatch = section.match(/^Source #(\d+)/m)
      if (!indexMatch) {
        return null
      }

      const nameMatch = section.match(/^\s*Name:\s+(.+)$/m)
      const monitorOfSinkMatch = section.match(/^\s*Monitor of Sink:\s+(.+)$/m)
      const deviceClassMatch = section.match(/device\.class = "([^"]+)"/)

      return {
        index: Number(indexMatch[1]),
        name: nameMatch ? nameMatch[1].trim() : '',
        monitor_source: monitorOfSinkMatch ? monitorOfSinkMatch[1].trim() : '',
        properties: {
          'device.class': deviceClassMatch ? deviceClassMatch[1] : '',
        },
      }
    })
    .filter(Boolean)
}

function isMonitorSource(source) {
  const monitorSource = source?.monitor_source
  const deviceClass = source?.properties?.['device.class']
  const name = source?.name || ''

  return (
    deviceClass === 'monitor' ||
    name.endsWith('.monitor') ||
    (typeof monitorSource === 'string' && monitorSource !== '' && monitorSource !== 'n/a')
  )
}

function readActiveMicrophoneProcessIds(env = process.env) {
  const activeProcesses = new Set()
  const monitorSourceIds = new Set(
    readSources(env)
      .filter(isMonitorSource)
      .map((source) => Number(source.index))
      .filter(Number.isFinite),
  )

  for (const sourceOutput of readSourceOutputs(env)) {
    const processId = sourceOutput?.properties?.['application.process.id']
    if (!processId) {
      continue
    }
    const sourceId = Number(sourceOutput?.source)
    if (Number.isFinite(sourceId) && monitorSourceIds.has(sourceId)) {
      continue
    }

    activeProcesses.add(Number(processId))
  }

  return activeProcesses
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

function resolveMicrophoneSource(env = process.env) {
  const explicitSource = (env.RECAPPI_PULSE_SOURCE || '').trim()
  if (explicitSource) {
    return explicitSource
  }

  return readPulseInfo(env).defaultSource
}

function safeInvoke(callback, ...args) {
  try {
    callback(...args)
  } catch {
    // Mirror native callback behavior by swallowing user callback exceptions.
  }
}

function buildCaptureArgs(env) {
  const monitorSource = resolveMonitorSource(env)
  const microphoneSource = resolveMicrophoneSource(env)
  const inputs = []

  if (microphoneSource && microphoneSource !== monitorSource) {
    inputs.push(['-f', 'pulse', '-i', microphoneSource])
  }
  inputs.push(['-f', 'pulse', '-i', monitorSource])

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  for (const input of inputs) {
    args.push(...input)
  }

  if (inputs.length > 1) {
    args.push(
      '-filter_complex',
      '[0:a][1:a]amix=inputs=2:weights=1 1:normalize=0,volume=0.5',
    )
  }

  args.push(
    '-ac',
    String(DEFAULT_CHANNELS),
    '-ar',
    String(DEFAULT_SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1',
  )

  return args
}

function startPulseCapture(audioStreamCallback, env = process.env) {
  const ffmpegArgs = buildCaptureArgs(env)
  const ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stopped = false
  let bufferedBytes = Buffer.alloc(0)
  let stderrBuffer = ''

  const emitError = (detail) => {
    safeInvoke(
      audioStreamCallback,
      createLinuxBackendError('ShareableContent.tapGlobalAudio', detail),
      undefined,
    )
  }

  ffmpegProc.on('error', (error) => {
    if (stopped) {
      return
    }
    emitError(`Failed to launch ffmpeg: ${error.message}`)
  })

  ffmpegProc.stderr.on('data', (chunk) => {
    stderrBuffer += String(chunk)
  })

  ffmpegProc.stdout.on('data', (chunk) => {
    if (stopped) {
      return
    }

    bufferedBytes =
      bufferedBytes.length === 0 ? Buffer.from(chunk) : Buffer.concat([bufferedBytes, chunk])
    const completeByteLength = bufferedBytes.length - (bufferedBytes.length % 4)
    if (completeByteLength === 0) {
      return
    }

    const completeBuffer = bufferedBytes.subarray(0, completeByteLength)
    bufferedBytes = bufferedBytes.subarray(completeByteLength)

    const samples = new Float32Array(completeBuffer.length / 4)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = completeBuffer.readFloatLE(index * 4)
    }

    safeInvoke(audioStreamCallback, null, samples)
  })

  ffmpegProc.on('close', (code, signal) => {
    if (stopped) {
      return
    }

    if (code === 0 || code === null || signal === 'SIGINT' || signal === 'SIGTERM') {
      return
    }

    const detail = stderrBuffer.trim() || `ffmpeg exited with ${code}`
    emitError(detail)
  })

  return new AudioCaptureSession(ffmpegProc, () => {
    stopped = true
  })
}

class ApplicationInfo {
  constructor(processId, name, objectId, metadata = {}) {
    this.processId = processId
    this.name = name
    this.objectId = objectId
    this._processGroupId = metadata.processGroupId ?? processId
    this._bundleIdentifier = metadata.bundleIdentifier ?? ''
  }

  get processGroupId() {
    return this._processGroupId
  }

  get bundleIdentifier() {
    if (this._bundleIdentifier) {
      return this._bundleIdentifier
    }

    this._bundleIdentifier = readExecutablePath(this.processId)
    return this._bundleIdentifier
  }

  get icon() {
    return Buffer.alloc(0)
  }
}

class ApplicationListChangedSubscriber {
  constructor(intervalId) {
    this._intervalId = intervalId
  }

  unsubscribe() {
    if (this._intervalId) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
  }
}

class ApplicationStateChangedSubscriber {
  constructor(intervalId) {
    this._intervalId = intervalId
  }

  unsubscribe() {
    if (this._intervalId) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
  }
}

class AudioCaptureSession {
  constructor(processHandle, onStop) {
    this._processHandle = processHandle
    this._onStop = onStop
    this._stopped = false
    this._sampleRate = DEFAULT_SAMPLE_RATE
    this._channels = DEFAULT_CHANNELS
    this._actualSampleRate = DEFAULT_SAMPLE_RATE
  }

  stop() {
    if (this._stopped) {
      return
    }

    this._stopped = true
    this._onStop?.()

    if (this._processHandle && this._processHandle.exitCode === null) {
      this._processHandle.kill('SIGINT')
      setTimeout(() => {
        if (this._processHandle && this._processHandle.exitCode === null) {
          this._processHandle.kill('SIGKILL')
        }
      }, 1_000).unref()
    }
  }

  get sampleRate() {
    return this._sampleRate
  }

  get channels() {
    return this._channels
  }

  get actualSampleRate() {
    return this._actualSampleRate
  }
}

class ShareableContent {
  constructor() {}

  static onApplicationListChanged(callback) {
    let previousSignature = ShareableContent.applications()
      .map((app) => app.processId)
      .sort((left, right) => left - right)
      .join(',')

    const intervalId = setInterval(() => {
      try {
        const currentSignature = ShareableContent.applications()
          .map((app) => app.processId)
          .sort((left, right) => left - right)
          .join(',')

        if (currentSignature !== previousSignature) {
          previousSignature = currentSignature
          safeInvoke(callback, null)
        }
      } catch (error) {
        safeInvoke(callback, error)
      }
    }, POLL_INTERVAL_MS)
    intervalId.unref?.()

    return new ApplicationListChangedSubscriber(intervalId)
  }

  static onAppStateChanged(app, callback) {
    let previousIsUsingMicrophone = ShareableContent.isUsingMicrophone(app.processId)

    const intervalId = setInterval(() => {
      try {
        const currentIsUsingMicrophone = ShareableContent.isUsingMicrophone(app.processId)
        if (currentIsUsingMicrophone !== previousIsUsingMicrophone) {
          previousIsUsingMicrophone = currentIsUsingMicrophone
          safeInvoke(callback, null)
        }
      } catch (error) {
        safeInvoke(callback, error)
      }
    }, POLL_INTERVAL_MS)
    intervalId.unref?.()

    return new ApplicationStateChangedSubscriber(intervalId)
  }

  static applications() {
    return parseLinuxProcessList()
  }

  static applicationWithProcessId(processId) {
    return ShareableContent.applications().find((app) => app.processId === Number(processId)) ?? null
  }

  static isUsingMicrophone(processId) {
    return readActiveMicrophoneProcessIds().has(Number(processId))
  }

  static tapAudio(_processId, audioStreamCallback) {
    return startPulseCapture(audioStreamCallback)
  }

  static tapGlobalAudio(_excludedProcesses, audioStreamCallback) {
    return startPulseCapture(audioStreamCallback)
  }
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

function playSineTone(env, sinkName, durationSeconds = 2.5, frequency = 440) {
  const wavPath = join(tmpdir(), `recappi-tone-${process.pid}.wav`)

  runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${durationSeconds}:sample_rate=${DEFAULT_SAMPLE_RATE}`,
    '-ac',
    '1',
    wavPath,
  ])

  try {
    runCommand('paplay', ['--device', sinkName, wavPath], { env })
  } finally {
    rmSync(wavPath, { force: true })
  }
}

function startSineTonePlayer(env, sinkName, durationSeconds = 2.5, frequency = 440) {
  const wavPath = join(tmpdir(), `recappi-tone-${process.pid}-${frequency}-${Date.now()}.wav`)

  runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${durationSeconds}:sample_rate=${DEFAULT_SAMPLE_RATE}`,
    '-ac',
    '1',
    wavPath,
  ])

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
  const ffmpegProc = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-re',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=${durationSeconds}:sample_rate=${DEFAULT_SAMPLE_RATE}`,
      '-ac',
      String(DEFAULT_CHANNELS),
      '-f',
      's16le',
      '-y',
      pipePath,
    ],
    {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )

  let stderrBuffer = ''
  ffmpegProc.stderr.on('data', (chunk) => {
    stderrBuffer += String(chunk)
  })

  return {
    process: ffmpegProc,
    wait() {
      return waitForChildProcess(
        ffmpegProc,
        'ShareableContent.tapGlobalAudio',
        (code) => stderrBuffer.trim() || `ffmpeg source writer exited with ${code}`,
      )
    },
  }
}

module.exports = {
  ApplicationInfo,
  ApplicationListChangedSubscriber,
  ApplicationStateChangedSubscriber,
  AudioCaptureSession,
  ShareableContent,
  createPrivatePulseFixture,
  getLinuxPlatformCapabilities,
  startPrivatePulseServer,
  playSineTone,
  startSineTonePlayer,
  startSineToneToSource,
  LINUX_CAPTURE_ERROR_CODE,
}
