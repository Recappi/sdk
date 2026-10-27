pub mod audio_capture;
pub(crate) mod error;
pub mod microphone_listener;
pub mod screen_capture_kit;

pub use audio_capture::*;
pub use microphone_listener::*;
pub use screen_capture_kit::*;

#[cfg(test)]
mod tests {
  use windows::{
    Win32::{
      Foundation::E_NOTIMPL,
      Media::Audio::{
        IAudioSessionControl, IAudioSessionNotification, IAudioSessionNotification_Impl,
      },
    },
    core::{IUnknown, Interface},
  };

  #[windows_core::implement(IAudioSessionNotification)]
  struct SessionNotification;

  impl IAudioSessionNotification_Impl for SessionNotification_Impl {
    fn OnSessionCreated(
      &self,
      _session: windows_core::Ref<'_, IAudioSessionControl>,
    ) -> windows_core::Result<()> {
      Err(E_NOTIMPL.into())
    }
  }

  #[test]
  fn audio_session_callback_uses_compatible_com_types() {
    // Exercise the direct windows-core macro and windows bindings together without
    // requiring an audio device or a Node.js environment.
    let notification: IAudioSessionNotification = SessionNotification.into();
    let unknown: IUnknown = notification.cast().unwrap();
    let notification: IAudioSessionNotification = unknown.cast().unwrap();

    let error = unsafe { notification.OnSessionCreated(None) }.unwrap_err();
    assert_eq!(error.code(), E_NOTIMPL);
  }
}
