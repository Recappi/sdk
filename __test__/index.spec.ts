import test from 'ava'

import sdk from '../index.cjs'

test('should expose audio decoder helpers', (t) => {
  t.is(typeof sdk.decodeAudio, 'function')
  t.is(typeof sdk.decodeAudioSync, 'function')
})

test('should expose platform capability metadata', (t) => {
  const capabilities = sdk.getPlatformCapabilities()

  t.is(capabilities.platform, process.platform)
  t.is(capabilities.decodeAudio, true)
  t.is(capabilities.decodeAudioSync, true)

  const expectsShareableContent = process.platform === 'darwin' || process.platform === 'win32'
  t.is(capabilities.applicationListing, expectsShareableContent)
  t.is(capabilities.tapAudio, expectsShareableContent)
  t.is(capabilities.tapGlobalAudio, expectsShareableContent)
})

test('should only expose shareable capture APIs on platforms with a native backend', (t) => {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    t.true(Array.isArray(sdk.ShareableContent.applications()))
    return
  }

  // @ts-expect-error - ShareableContent is not defined on decoder-only platforms
  t.is(sdk.ShareableContent, undefined)
})
