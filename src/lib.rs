use napi_derive::napi;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::*;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

pub mod audio_decoder;

#[napi(object)]
pub struct PlatformCapabilities {
  pub platform: String,
  pub arch: String,
  pub decode_audio: bool,
  pub decode_audio_sync: bool,
  pub application_listing: bool,
  pub application_lookup: bool,
  pub application_list_events: bool,
  pub application_state_events: bool,
  pub microphone_state: bool,
  pub tap_audio: bool,
  pub tap_global_audio: bool,
}

fn node_platform_name() -> &'static str {
  match std::env::consts::OS {
    "macos" => "darwin",
    "windows" => "win32",
    other => other,
  }
}

fn node_arch_name() -> &'static str {
  match std::env::consts::ARCH {
    "x86_64" => "x64",
    "x86" => "ia32",
    "aarch64" => "arm64",
    other => other,
  }
}

#[napi]
pub fn get_platform_capabilities() -> PlatformCapabilities {
  #[cfg(target_os = "linux")]
  let linux_capabilities = linux::get_linux_platform_capabilities();

  PlatformCapabilities {
    platform: node_platform_name().to_owned(),
    arch: node_arch_name().to_owned(),
    decode_audio: true,
    decode_audio_sync: true,
    #[cfg(target_os = "linux")]
    application_listing: linux_capabilities.application_listing,
    #[cfg(not(target_os = "linux"))]
    application_listing: true,
    #[cfg(target_os = "linux")]
    application_lookup: linux_capabilities.application_lookup,
    #[cfg(not(target_os = "linux"))]
    application_lookup: true,
    #[cfg(target_os = "linux")]
    application_list_events: linux_capabilities.application_list_events,
    #[cfg(not(target_os = "linux"))]
    application_list_events: true,
    #[cfg(target_os = "linux")]
    application_state_events: linux_capabilities.application_state_events,
    #[cfg(not(target_os = "linux"))]
    application_state_events: true,
    #[cfg(target_os = "linux")]
    microphone_state: linux_capabilities.microphone_state,
    #[cfg(not(target_os = "linux"))]
    microphone_state: true,
    #[cfg(target_os = "linux")]
    tap_audio: linux_capabilities.tap_audio,
    #[cfg(not(target_os = "linux"))]
    tap_audio: true,
    #[cfg(target_os = "linux")]
    tap_global_audio: linux_capabilities.tap_global_audio,
    #[cfg(not(target_os = "linux"))]
    tap_global_audio: true,
  }
}
