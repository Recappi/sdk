import test from 'ava'

import sdk from '../index.cjs'

test('should expose audio decoder helpers', (t) => {
  t.is(typeof sdk.decodeAudio, 'function')
  t.is(typeof sdk.decodeAudioSync, 'function')
})

test('should only expose shareable capture APIs on platforms with a native backend', (t) => {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    t.true(Array.isArray(sdk.ShareableContent.applications()))
    return
  }

  // @ts-expect-error - ShareableContent is not defined on decoder-only platforms
  t.is(sdk.ShareableContent, undefined)
})
