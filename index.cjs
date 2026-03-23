const nativeBinding = require('./native.cjs')
const linuxShareableContent =
  process.platform === 'linux' ? require('./linux-shareable-content.cjs') : null

function getShareableContentModule() {
  return process.platform === 'linux' ? linuxShareableContent : nativeBinding
}

function getPlatformCapabilities() {
  const shareableContent = getShareableContentModule()?.ShareableContent
  const linuxCapabilities =
    process.platform === 'linux'
      ? linuxShareableContent.getLinuxPlatformCapabilities?.(process.env)
      : null

  return {
    platform: process.platform,
    arch: process.arch,
    decodeAudio: typeof nativeBinding?.decodeAudio === 'function',
    decodeAudioSync: typeof nativeBinding?.decodeAudioSync === 'function',
    applicationListing:
      process.platform === 'linux'
        ? linuxCapabilities.applicationListing
        : typeof shareableContent?.applications === 'function',
    applicationLookup:
      process.platform === 'linux'
        ? linuxCapabilities.applicationLookup
        : typeof shareableContent?.applicationWithProcessId === 'function',
    applicationListEvents:
      process.platform === 'linux'
        ? linuxCapabilities.applicationListEvents
        : typeof shareableContent?.onApplicationListChanged === 'function',
    applicationStateEvents:
      process.platform === 'linux'
        ? linuxCapabilities.applicationStateEvents
        : typeof shareableContent?.onAppStateChanged === 'function',
    microphoneState:
      process.platform === 'linux'
        ? linuxCapabilities.microphoneState
        : typeof shareableContent?.isUsingMicrophone === 'function',
    tapAudio:
      process.platform === 'linux'
        ? linuxCapabilities.tapAudio
        : typeof shareableContent?.tapAudio === 'function',
    tapGlobalAudio:
      process.platform === 'linux'
        ? linuxCapabilities.tapGlobalAudio
        : typeof shareableContent?.tapGlobalAudio === 'function',
  }
}

module.exports = nativeBinding
module.exports.ApplicationInfo = getShareableContentModule().ApplicationInfo
module.exports.ApplicationListChangedSubscriber =
  getShareableContentModule().ApplicationListChangedSubscriber
module.exports.ApplicationStateChangedSubscriber =
  getShareableContentModule().ApplicationStateChangedSubscriber
module.exports.AudioCaptureSession = getShareableContentModule().AudioCaptureSession
module.exports.ShareableContent = getShareableContentModule().ShareableContent
module.exports.decodeAudio = nativeBinding.decodeAudio
module.exports.decodeAudioSync = nativeBinding.decodeAudioSync
module.exports.getPlatformCapabilities = getPlatformCapabilities
