pub mod audio_capture;
// Generated bindings retain Windows API names and include signature dependencies.
#[allow(non_snake_case, non_camel_case_types, non_upper_case_globals, dead_code, clippy::all)]
#[rustfmt::skip]
pub(crate) mod audio_bindings;
pub(crate) mod error;
pub mod microphone_listener;
pub mod screen_capture_kit;

pub use audio_capture::*;
pub use microphone_listener::*;
pub use screen_capture_kit::*;

#[cfg(test)]
mod tests {
  use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
  };

  use windows_core::{IUnknown, Interface};

  use super::audio_bindings::{
    E_NOTIMPL, IAudioSessionControl, IAudioSessionNotification, IAudioSessionNotification_Impl,
  };

  #[windows_core::implement(IAudioSessionNotification)]
  struct SessionNotification {
    calls: Arc<AtomicUsize>,
    fail: bool,
  }

  impl IAudioSessionNotification_Impl for SessionNotification_Impl {
    fn OnSessionCreated(
      &self,
      session: windows_core::Ref<'_, IAudioSessionControl>,
    ) -> windows_core::Result<()> {
      assert!(session.as_ref().is_none());
      self.calls.fetch_add(1, Ordering::SeqCst);
      if self.fail {
        Err(E_NOTIMPL.into())
      } else {
        Ok(())
      }
    }
  }

  #[test]
  fn audio_session_callback_uses_generated_com_types() {
    // Exercise the current windows-core macro and generated audio bindings without
    // requiring an audio device or a Node.js environment.
    for fail in [false, true] {
      let calls = Arc::new(AtomicUsize::new(0));
      let notification: IAudioSessionNotification = SessionNotification {
        calls: calls.clone(),
        fail,
      }
      .into();
      let unknown: IUnknown = notification.cast().unwrap();
      drop(notification);
      let notification: IAudioSessionNotification = unknown.cast().unwrap();
      drop(unknown);

      // The generated call returns HRESULT in 0.100; both success and failure
      // must survive the implementation macro's COM ABI round trip.
      let result = unsafe { notification.OnSessionCreated(None) }.ok();
      if fail {
        assert_eq!(result.unwrap_err().code(), E_NOTIMPL);
      } else {
        result.unwrap();
      }
      assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
  }
}
