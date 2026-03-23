/// <reference types="node" />

import test from 'ava'

import sdk from '../index.cjs'

test('should expose audio decoder helpers', (t) => {
  t.is(typeof sdk.decodeAudio, 'function')
  t.is(typeof sdk.decodeAudioSync, 'function')
})

test('should expose the shareable content surface on every supported desktop platform', (t) => {
  t.is(typeof sdk.ApplicationInfo, 'function')
  t.is(typeof sdk.ApplicationListChangedSubscriber, 'function')
  t.is(typeof sdk.ApplicationStateChangedSubscriber, 'function')
  t.is(typeof sdk.AudioCaptureSession, 'function')
  t.is(typeof sdk.ShareableContent, 'function')
  t.is(typeof sdk.ShareableContent.applications, 'function')
  t.is(typeof sdk.ShareableContent.applicationWithProcessId, 'function')
  t.is(typeof sdk.ShareableContent.onApplicationListChanged, 'function')
  t.is(typeof sdk.ShareableContent.onAppStateChanged, 'function')
  t.is(typeof sdk.ShareableContent.isUsingMicrophone, 'function')
  t.is(typeof sdk.ShareableContent.tapAudio, 'function')
  t.is(typeof sdk.ShareableContent.tapGlobalAudio, 'function')
})

test('should expose platform capability metadata', (t) => {
  const capabilities = sdk.getPlatformCapabilities()

  t.is(capabilities.platform, process.platform)
  t.is(capabilities.decodeAudio, true)
  t.is(capabilities.decodeAudioSync, true)

  const expectsShareableContent =
    process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
  t.is(capabilities.applicationListing, expectsShareableContent)
  t.is(capabilities.applicationLookup, expectsShareableContent)
  t.is(capabilities.applicationListEvents, expectsShareableContent)

  if (process.platform === 'darwin' || process.platform === 'win32') {
    t.true(capabilities.applicationStateEvents)
    t.true(capabilities.microphoneState)
    t.true(capabilities.tapAudio)
    t.true(capabilities.tapGlobalAudio)
    return
  }

  if (process.platform === 'linux') {
    t.is(typeof capabilities.applicationStateEvents, 'boolean')
    t.is(typeof capabilities.microphoneState, 'boolean')
    t.is(typeof capabilities.tapAudio, 'boolean')
    t.is(typeof capabilities.tapGlobalAudio, 'boolean')
    return
  }

  t.false(capabilities.applicationStateEvents)
  t.false(capabilities.microphoneState)
  t.false(capabilities.tapAudio)
  t.false(capabilities.tapGlobalAudio)
})

test('should make application discovery available on supported desktop platforms', (t) => {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    t.true(Array.isArray(sdk.ShareableContent.applications()))
    return
  }

  t.false('ShareableContent' in sdk)
})
