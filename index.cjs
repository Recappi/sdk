const nativeBinding = require('./native.cjs')
const linuxShareableContent =
  process.platform === 'linux' ? require('./linux-shareable-content.cjs') : null

function getShareableContentModule() {
  return process.platform === 'linux' ? linuxShareableContent : nativeBinding
}

function getPlatformCapabilities() {
  const shareableContent = getShareableContentModule()?.ShareableContent

  return {
    platform: process.platform,
    arch: process.arch,
    decodeAudio: typeof nativeBinding?.decodeAudio === 'function',
    decodeAudioSync: typeof nativeBinding?.decodeAudioSync === 'function',
    applicationListing: typeof shareableContent?.applications === 'function',
    applicationLookup: typeof shareableContent?.applicationWithProcessId === 'function',
    applicationListEvents: typeof shareableContent?.onApplicationListChanged === 'function',
    applicationStateEvents: typeof shareableContent?.onAppStateChanged === 'function',
    microphoneState: typeof shareableContent?.isUsingMicrophone === 'function',
    tapAudio: typeof shareableContent?.tapAudio === 'function',
    tapGlobalAudio: typeof shareableContent?.tapGlobalAudio === 'function',
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
