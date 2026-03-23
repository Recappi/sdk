use std::{
  collections::{HashMap, HashSet},
  env,
  fs::read_link,
  io::{BufReader, Read},
  os::unix::fs::PermissionsExt,
  path::Path,
  process::{Child, Command, Stdio},
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
  },
  thread::{self, JoinHandle},
  time::{Duration, Instant},
};

use napi::{
  bindgen_prelude::{Buffer, Error, Float32Array, Result, Status},
  threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

const DEFAULT_SAMPLE_RATE: u32 = 16_000;
const DEFAULT_CHANNELS: u32 = 1;
const POLL_INTERVAL: Duration = Duration::from_millis(1_000);
const PROCESS_REROUTE_POLL_INTERVAL: Duration = Duration::from_millis(100);
const CAPTURE_FEATURE: &str = "ShareableContent.tapGlobalAudio";
const PROCESS_CAPTURE_FEATURE: &str = "ShareableContent.tapAudio";
static CAPTURE_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy)]
pub struct LinuxPlatformCapabilities {
  pub application_listing: bool,
  pub application_lookup: bool,
  pub application_list_events: bool,
  pub application_state_events: bool,
  pub microphone_state: bool,
  pub tap_audio: bool,
  pub tap_global_audio: bool,
}

struct PulseInfo {
  default_sink: String,
  default_source: String,
}

struct SourceOutputInfo {
  process_id: i32,
  source_id: Option<u32>,
}

struct SinkInputInfo {
  index: u32,
  process_id: Option<i32>,
  sink_name: String,
  driver: String,
  media_name: String,
}

struct SinkInfo {
  index: u32,
  name: String,
}

struct SourceInfo {
  index: u32,
  name: String,
  monitor_of_sink: String,
  device_class: String,
}

struct ProcessTapRouting {
  capture_sink: String,
  sink_module_id: Option<String>,
  loopback_route: Arc<Mutex<Option<LoopbackRoute>>>,
  stop_flag: Arc<AtomicBool>,
  worker_thread: Option<JoinHandle<()>>,
  moved_inputs: Arc<Mutex<HashMap<u32, String>>>,
}

struct GlobalExcludedTapRouting {
  capture_sink: String,
  sink_module_id: Option<String>,
  loopback_module_id: Option<String>,
  target_sink: String,
  stop_flag: Arc<AtomicBool>,
  worker_thread: Option<JoinHandle<()>>,
  moved_inputs: Arc<Mutex<HashMap<u32, String>>>,
}

#[derive(Clone)]
struct LoopbackRoute {
  module_id: String,
  sink: String,
}

enum LinuxCaptureRouting {
  Process(ProcessTapRouting),
  GlobalExcluded(GlobalExcludedTapRouting),
}

fn linux_backend_error(feature: &str, detail: impl AsRef<str>) -> Error {
  let detail = detail.as_ref().trim();
  let message = if detail.is_empty() {
    format!(
      "{feature} requires PulseAudio-compatible tooling on Linux (pactl, ffmpeg, and an available Pulse server)."
    )
  } else {
    format!(
      "{feature} requires PulseAudio-compatible tooling on Linux (pactl, ffmpeg, and an available Pulse server). {detail}"
    )
  };

  Error::new(Status::GenericFailure, message)
}

fn run_command(command: &str, args: &[&str], feature: &str) -> Result<String> {
  let output = Command::new(command).args(args).output().map_err(|err| {
    linux_backend_error(
      feature,
      format!(r#"Failed to start "{command} {}": {err}"#, args.join(" ")),
    )
  })?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() {
      stderr
    } else if !stdout.is_empty() {
      stdout
    } else if let Some(code) = output.status.code() {
      format!(
        r#"Command "{command} {}" exited with {code}."#,
        args.join(" ")
      )
    } else {
      format!(
        r#"Command "{command} {}" exited unexpectedly."#,
        args.join(" ")
      )
    };
    return Err(linux_backend_error(feature, detail));
  }

  Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn is_command_available(command: &str) -> bool {
  if command.contains('/') {
    return Path::new(command)
      .metadata()
      .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
      .unwrap_or(false);
  }

  let Some(path) = env::var_os("PATH") else {
    return false;
  };

  env::split_paths(&path).any(|dir| {
    dir
      .join(command)
      .metadata()
      .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
      .unwrap_or(false)
  })
}

fn parse_linux_process_list() -> Result<Vec<ApplicationInfo>> {
  let output = run_command(
    "ps",
    &["-eo", "pid=,pgid=,comm="],
    "ShareableContent.applications",
  )?;

  Ok(
    output
      .lines()
      .filter_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() {
          return None;
        }

        let mut parts = trimmed.split_whitespace();
        let process_id = parts.next()?.parse::<i32>().ok()?;
        let _process_group_id = parts.next()?.parse::<i32>().ok()?;
        let name = parts.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
          return None;
        }

        Some(ApplicationInfo::new(process_id, name, process_id as u32))
      })
      .collect(),
  )
}

fn read_executable_path(process_id: i32) -> String {
  read_link(format!("/proc/{process_id}/exe"))
    .map(|path| path.to_string_lossy().into_owned())
    .unwrap_or_default()
}

fn read_pulse_info() -> Result<PulseInfo> {
  let output = run_command("pactl", &["info"], CAPTURE_FEATURE)?;
  let mut default_sink = String::new();
  let mut default_source = String::new();

  for line in output.lines() {
    if let Some(value) = line.strip_prefix("Default Sink:") {
      default_sink = value.trim().to_owned();
    } else if let Some(value) = line.strip_prefix("Default Source:") {
      default_source = value.trim().to_owned();
    }
  }

  Ok(PulseInfo {
    default_sink,
    default_source,
  })
}

fn split_sections(output: &str, header_prefix: &str) -> Vec<String> {
  let mut sections = Vec::new();
  let mut current = String::new();

  for line in output.lines() {
    if line.starts_with(header_prefix) && !current.is_empty() {
      sections.push(current);
      current = String::new();
    }

    if !current.is_empty() {
      current.push('\n');
    }
    current.push_str(line);
  }

  if !current.is_empty() {
    sections.push(current);
  }

  sections
}

fn extract_line_value(section: &str, prefix: &str) -> Option<String> {
  section.lines().find_map(|line| {
    let trimmed = line.trim_start();
    trimmed
      .strip_prefix(prefix)
      .map(|value| value.trim().to_owned())
  })
}

fn extract_quoted_property(section: &str, key: &str) -> Option<String> {
  let needle = format!(r#"{key} = ""#);
  let start = section.find(&needle)?;
  let value = &section[start + needle.len()..];
  let end = value.find('"')?;
  Some(value[..end].to_owned())
}

fn read_source_outputs() -> Result<Vec<SourceOutputInfo>> {
  let output = run_command("pactl", &["list", "source-outputs"], CAPTURE_FEATURE)?;

  Ok(
    split_sections(&output, "Source Output #")
      .into_iter()
      .filter_map(|section| {
        let process_id = extract_quoted_property(&section, "application.process.id")?
          .parse::<i32>()
          .ok()?;
        let source_id =
          extract_line_value(&section, "Source:").and_then(|value| value.parse::<u32>().ok());

        Some(SourceOutputInfo {
          process_id,
          source_id,
        })
      })
      .collect(),
  )
}

fn read_sinks(feature: &str) -> Result<Vec<SinkInfo>> {
  let output = run_command("pactl", &["list", "sinks"], feature)?;

  Ok(
    split_sections(&output, "Sink #")
      .into_iter()
      .filter_map(|section| {
        let header = section.lines().next()?.trim();
        let index = header.strip_prefix("Sink #")?.trim().parse::<u32>().ok()?;
        let name = extract_line_value(&section, "Name:")?;

        Some(SinkInfo { index, name })
      })
      .collect(),
  )
}

fn read_sink_inputs(feature: &str) -> Result<Vec<SinkInputInfo>> {
  let sinks_by_index = read_sinks(feature)?
    .into_iter()
    .map(|sink| (sink.index, sink.name))
    .collect::<HashMap<_, _>>();
  let output = run_command("pactl", &["list", "sink-inputs"], feature)?;

  Ok(
    split_sections(&output, "Sink Input #")
      .into_iter()
      .filter_map(|section| {
        let header = section.lines().next()?.trim();
        let index = header
          .strip_prefix("Sink Input #")?
          .trim()
          .parse::<u32>()
          .ok()?;
        let process_id = extract_quoted_property(&section, "application.process.id")
          .and_then(|value| value.parse::<i32>().ok());
        let sink = extract_line_value(&section, "Sink:")?;
        let sink_name = sink
          .parse::<u32>()
          .ok()
          .and_then(|index| sinks_by_index.get(&index).cloned())
          .unwrap_or(sink);
        let driver = extract_line_value(&section, "Driver:").unwrap_or_default();
        let media_name = extract_quoted_property(&section, "media.name").unwrap_or_default();

        Some(SinkInputInfo {
          index,
          process_id,
          sink_name,
          driver,
          media_name,
        })
      })
      .collect(),
  )
}

fn read_sources() -> Result<Vec<SourceInfo>> {
  let output = run_command("pactl", &["list", "sources"], CAPTURE_FEATURE)?;

  Ok(
    split_sections(&output, "Source #")
      .into_iter()
      .filter_map(|section| {
        let header = section.lines().next()?.trim();
        let index = header
          .strip_prefix("Source #")?
          .trim()
          .parse::<u32>()
          .ok()?;
        let name = extract_line_value(&section, "Name:").unwrap_or_default();
        let monitor_of_sink = extract_line_value(&section, "Monitor of Sink:").unwrap_or_default();
        let device_class = extract_quoted_property(&section, "device.class").unwrap_or_default();

        Some(SourceInfo {
          index,
          name,
          monitor_of_sink,
          device_class,
        })
      })
      .collect(),
  )
}

fn is_monitor_source(source: &SourceInfo) -> bool {
  source.device_class == "monitor"
    || source.name.ends_with(".monitor")
    || (!source.monitor_of_sink.is_empty() && source.monitor_of_sink != "n/a")
}

fn read_active_microphone_process_ids() -> Result<HashSet<i32>> {
  let monitor_source_ids = read_sources()?
    .into_iter()
    .filter(is_monitor_source)
    .map(|source| source.index)
    .collect::<HashSet<_>>();

  let mut active_processes = HashSet::new();
  for source_output in read_source_outputs()? {
    if let Some(source_id) = source_output.source_id
      && monitor_source_ids.contains(&source_id)
    {
      continue;
    }

    active_processes.insert(source_output.process_id);
  }

  Ok(active_processes)
}

fn can_read_pulse_info() -> bool {
  read_pulse_info().is_ok()
}

fn resolve_monitor_source() -> Result<String> {
  if let Ok(source) = env::var("RECAPPI_PULSE_MONITOR_SOURCE") {
    let trimmed = source.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_owned());
    }
  }

  let pulse_info = read_pulse_info()?;
  if pulse_info.default_sink.is_empty() {
    return Err(linux_backend_error(
      CAPTURE_FEATURE,
      "PulseAudio did not report a default sink.",
    ));
  }

  Ok(format!("{}.monitor", pulse_info.default_sink))
}

fn resolve_microphone_source() -> Result<String> {
  if let Ok(source) = env::var("RECAPPI_PULSE_SOURCE") {
    let trimmed = source.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_owned());
    }
  }

  Ok(read_pulse_info()?.default_source)
}

fn can_resolve_monitor_source() -> bool {
  resolve_monitor_source().is_ok()
}

fn is_monitor_source_name(source_name: &str) -> bool {
  source_name.ends_with(".monitor")
}

fn next_capture_session_id() -> u64 {
  CAPTURE_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn build_capture_sink_name(prefix: &str, process_id: Option<i32>, session_id: u64) -> String {
  match process_id {
    Some(process_id) => format!(
      "recappi_{}_{}_{}_{}",
      prefix,
      process_id.max(0),
      std::process::id(),
      session_id
    ),
    None => format!("recappi_{}_{}_{}", prefix, std::process::id(), session_id),
  }
}

fn is_loopback_sink_input(sink_input: &SinkInputInfo) -> bool {
  sink_input.driver == "module-loopback.c" || sink_input.media_name.starts_with("Loopback from ")
}

fn move_sink_input(index: u32, sink: &str) -> Result<()> {
  let index_arg = index.to_string();
  run_command(
    "pactl",
    &["move-sink-input", index_arg.as_str(), sink],
    PROCESS_CAPTURE_FEATURE,
  )?;
  Ok(())
}

fn create_capture_sink(capture_sink: &str, feature: &str) -> Result<String> {
  run_command(
    "pactl",
    &[
      "load-module",
      "module-null-sink",
      &format!("sink_name={capture_sink}"),
    ],
    feature,
  )
}

fn create_loopback(source: &str, sink: &str, feature: &str) -> Result<String> {
  run_command(
    "pactl",
    &[
      "load-module",
      "module-loopback",
      &format!("source={source}"),
      &format!("sink={sink}"),
      "latency_msec=1",
    ],
    feature,
  )
}

fn unload_module(module_id: &str, feature: &str) {
  let _ = run_command("pactl", &["unload-module", module_id], feature);
}

fn resolve_monitor_sink_name() -> Result<String> {
  let monitor_source = resolve_monitor_source()?;
  if let Some(sink_name) = monitor_source.strip_suffix(".monitor") {
    return Ok(sink_name.to_owned());
  }

  Err(linux_backend_error(
    CAPTURE_FEATURE,
    format!(
      r#"Linux exclusions require a monitor sink source, but "{monitor_source}" is not a sink monitor."#
    ),
  ))
}

fn can_probe_process_capture_route() -> bool {
  let Ok(pulse_info) = read_pulse_info() else {
    return false;
  };
  if pulse_info.default_sink.is_empty() {
    return false;
  }
  if read_sink_inputs(PROCESS_CAPTURE_FEATURE).is_err() {
    return false;
  }

  let capture_sink = build_capture_sink_name("probe", None, next_capture_session_id());
  let Ok(sink_module_id) = create_capture_sink(&capture_sink, PROCESS_CAPTURE_FEATURE) else {
    return false;
  };

  let loopback_result = create_loopback(
    &format!("{}.monitor", capture_sink),
    &pulse_info.default_sink,
    PROCESS_CAPTURE_FEATURE,
  );
  if let Ok(loopback_module_id) = &loopback_result {
    unload_module(loopback_module_id, PROCESS_CAPTURE_FEATURE);
  }
  unload_module(&sink_module_id, PROCESS_CAPTURE_FEATURE);

  loopback_result.is_ok()
}

fn reroute_global_sink_inputs(
  target_sink: &str,
  capture_sink: &str,
  excluded_process_ids: &HashSet<i32>,
  moved_inputs: &Arc<Mutex<HashMap<u32, String>>>,
) -> Result<()> {
  for sink_input in read_sink_inputs(CAPTURE_FEATURE)? {
    if sink_input.sink_name != target_sink
      || sink_input.sink_name == capture_sink
      || is_loopback_sink_input(&sink_input)
    {
      continue;
    }

    if let Some(process_id) = sink_input.process_id
      && excluded_process_ids.contains(&process_id)
    {
      continue;
    }

    move_sink_input(sink_input.index, capture_sink)?;
    if let Ok(mut moved_inputs) = moved_inputs.lock() {
      moved_inputs
        .entry(sink_input.index)
        .or_insert_with(|| sink_input.sink_name.clone());
    }
  }

  Ok(())
}

fn ensure_process_loopback(
  capture_sink: &str,
  source_sink: &str,
  loopback_route: &Arc<Mutex<Option<LoopbackRoute>>>,
) -> Result<bool> {
  let mut loopback_route = loopback_route
    .lock()
    .map_err(|_| linux_backend_error(PROCESS_CAPTURE_FEATURE, "Loopback state was poisoned."))?;

  if let Some(existing) = loopback_route.as_ref() {
    return Ok(existing.sink == source_sink);
  }

  let module_id = create_loopback(
    &format!("{}.monitor", capture_sink),
    source_sink,
    PROCESS_CAPTURE_FEATURE,
  )?;
  *loopback_route = Some(LoopbackRoute {
    module_id,
    sink: source_sink.to_owned(),
  });

  Ok(true)
}

fn reroute_process_sink_inputs(
  process_id: i32,
  capture_sink: &str,
  moved_inputs: &Arc<Mutex<HashMap<u32, String>>>,
  loopback_route: &Arc<Mutex<Option<LoopbackRoute>>>,
) -> Result<()> {
  for sink_input in read_sink_inputs(PROCESS_CAPTURE_FEATURE)? {
    if sink_input.process_id != Some(process_id) || sink_input.sink_name == capture_sink {
      continue;
    }

    if !ensure_process_loopback(capture_sink, &sink_input.sink_name, loopback_route)? {
      continue;
    }

    move_sink_input(sink_input.index, capture_sink)?;
    if let Ok(mut moved_inputs) = moved_inputs.lock() {
      moved_inputs
        .entry(sink_input.index)
        .or_insert_with(|| sink_input.sink_name.clone());
    }
  }

  Ok(())
}

impl ProcessTapRouting {
  fn start(process_id: i32) -> Result<Self> {
    let pulse_info = read_pulse_info()?;
    if pulse_info.default_sink.is_empty() {
      return Err(linux_backend_error(
        PROCESS_CAPTURE_FEATURE,
        "PulseAudio did not report a default sink.",
      ));
    }

    let capture_sink =
      build_capture_sink_name("capture", Some(process_id), next_capture_session_id());
    let sink_module_id = create_capture_sink(&capture_sink, PROCESS_CAPTURE_FEATURE)?;

    let moved_inputs = Arc::new(Mutex::new(HashMap::new()));
    let loopback_route = Arc::new(Mutex::new(None));
    if let Err(err) =
      reroute_process_sink_inputs(process_id, &capture_sink, &moved_inputs, &loopback_route)
    {
      unload_module(&sink_module_id, PROCESS_CAPTURE_FEATURE);
      return Err(err);
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = stop_flag.clone();
    let moved_inputs_for_thread = moved_inputs.clone();
    let loopback_route_for_thread = loopback_route.clone();
    let capture_sink_for_thread = capture_sink.clone();
    let worker_thread = thread::spawn(move || {
      while !stop_flag_for_thread.load(Ordering::Relaxed) {
        let _ = reroute_process_sink_inputs(
          process_id,
          &capture_sink_for_thread,
          &moved_inputs_for_thread,
          &loopback_route_for_thread,
        );
        thread::sleep(PROCESS_REROUTE_POLL_INTERVAL);
      }
    });

    Ok(Self {
      capture_sink,
      sink_module_id: Some(sink_module_id),
      loopback_route,
      stop_flag,
      worker_thread: Some(worker_thread),
      moved_inputs,
    })
  }

  fn cleanup(&mut self) {
    self.stop_flag.store(true, Ordering::Relaxed);
    if let Some(worker_thread) = self.worker_thread.take() {
      let _ = worker_thread.join();
    }

    if let Ok(mut loopback_route) = self.loopback_route.lock()
      && let Some(route) = loopback_route.take()
    {
      unload_module(&route.module_id, PROCESS_CAPTURE_FEATURE);
    }

    let moved_inputs = self
      .moved_inputs
      .lock()
      .map(|moved_inputs| moved_inputs.clone())
      .unwrap_or_default();
    for (input_index, original_sink) in moved_inputs {
      if !original_sink.is_empty() {
        let _ = move_sink_input(input_index, &original_sink);
      }
    }

    if let Some(sink_module_id) = self.sink_module_id.take() {
      unload_module(&sink_module_id, PROCESS_CAPTURE_FEATURE);
    }
  }
}

impl Drop for ProcessTapRouting {
  fn drop(&mut self) {
    self.cleanup();
  }
}

impl GlobalExcludedTapRouting {
  fn start(excluded_process_ids: HashSet<i32>) -> Result<Self> {
    let pulse_info = read_pulse_info()?;
    let target_sink = resolve_monitor_sink_name()?;
    if pulse_info.default_sink.is_empty() || target_sink.is_empty() {
      return Err(linux_backend_error(
        CAPTURE_FEATURE,
        "PulseAudio did not report a default sink.",
      ));
    }

    let capture_sink = build_capture_sink_name("global_capture", None, next_capture_session_id());
    let sink_module_id = create_capture_sink(&capture_sink, CAPTURE_FEATURE)?;
    let loopback_module_id = match create_loopback(
      &format!("{}.monitor", capture_sink),
      &target_sink,
      CAPTURE_FEATURE,
    ) {
      Ok(module_id) => module_id,
      Err(err) => {
        unload_module(&sink_module_id, CAPTURE_FEATURE);
        return Err(err);
      }
    };

    let moved_inputs = Arc::new(Mutex::new(HashMap::new()));
    if let Err(err) = reroute_global_sink_inputs(
      &target_sink,
      &capture_sink,
      &excluded_process_ids,
      &moved_inputs,
    ) {
      unload_module(&loopback_module_id, CAPTURE_FEATURE);
      unload_module(&sink_module_id, CAPTURE_FEATURE);
      return Err(err);
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = stop_flag.clone();
    let moved_inputs_for_thread = moved_inputs.clone();
    let capture_sink_for_thread = capture_sink.clone();
    let target_sink_for_thread = target_sink.clone();
    let worker_thread = thread::spawn(move || {
      while !stop_flag_for_thread.load(Ordering::Relaxed) {
        let _ = reroute_global_sink_inputs(
          &target_sink_for_thread,
          &capture_sink_for_thread,
          &excluded_process_ids,
          &moved_inputs_for_thread,
        );
        thread::sleep(PROCESS_REROUTE_POLL_INTERVAL);
      }
    });

    Ok(Self {
      capture_sink,
      sink_module_id: Some(sink_module_id),
      loopback_module_id: Some(loopback_module_id),
      target_sink,
      stop_flag,
      worker_thread: Some(worker_thread),
      moved_inputs,
    })
  }

  fn cleanup(&mut self) {
    self.stop_flag.store(true, Ordering::Relaxed);
    if let Some(worker_thread) = self.worker_thread.take() {
      let _ = worker_thread.join();
    }

    if let Some(loopback_module_id) = self.loopback_module_id.take() {
      unload_module(&loopback_module_id, CAPTURE_FEATURE);
    }

    let moved_inputs = self
      .moved_inputs
      .lock()
      .map(|moved_inputs| moved_inputs.clone())
      .unwrap_or_default();
    for (input_index, original_sink) in moved_inputs {
      let restore_sink = if original_sink.is_empty() {
        self.target_sink.as_str()
      } else {
        original_sink.as_str()
      };
      let _ = move_sink_input(input_index, restore_sink);
    }

    if let Some(sink_module_id) = self.sink_module_id.take() {
      unload_module(&sink_module_id, CAPTURE_FEATURE);
    }
  }
}

impl Drop for GlobalExcludedTapRouting {
  fn drop(&mut self) {
    self.cleanup();
  }
}

pub fn get_linux_platform_capabilities() -> LinuxPlatformCapabilities {
  let has_ps = is_command_available("ps");
  let has_pactl = is_command_available("pactl");
  let has_ffmpeg = is_command_available("ffmpeg");
  let pulse_runtime_ready = has_pactl && can_read_pulse_info();
  let capture_runtime_ready = pulse_runtime_ready && has_ffmpeg && can_resolve_monitor_source();
  let process_capture_runtime_ready = capture_runtime_ready && can_probe_process_capture_route();

  LinuxPlatformCapabilities {
    application_listing: has_ps,
    application_lookup: has_ps,
    application_list_events: has_ps,
    application_state_events: pulse_runtime_ready,
    microphone_state: pulse_runtime_ready,
    tap_audio: process_capture_runtime_ready,
    tap_global_audio: capture_runtime_ready,
  }
}

fn build_capture_args_for_sources(
  monitor_sources: &mut Vec<String>,
  microphone_source: Option<String>,
) -> Vec<String> {
  let mut inputs = Vec::new();

  if let Some(microphone_source) = microphone_source
    && !microphone_source.is_empty()
    && !monitor_sources.contains(&microphone_source)
    && !is_monitor_source_name(&microphone_source)
  {
    inputs.push(vec![
      "-f".to_owned(),
      "pulse".to_owned(),
      "-i".to_owned(),
      microphone_source,
    ]);
  }

  for monitor_source in monitor_sources.drain(..) {
    inputs.push(vec![
      "-f".to_owned(),
      "pulse".to_owned(),
      "-i".to_owned(),
      monitor_source,
    ]);
  }

  let mut args = vec![
    "-hide_banner".to_owned(),
    "-loglevel".to_owned(),
    "error".to_owned(),
    "-nostdin".to_owned(),
  ];

  for input in inputs.iter() {
    args.extend(input.iter().cloned());
  }

  if inputs.len() > 1 {
    args.push("-filter_complex".to_owned());
    let input_refs = (0..inputs.len())
      .map(|index| format!("[{index}:a]"))
      .collect::<String>();
    args.push(format!(
      "{input_refs}amix=inputs={}:weights={}:normalize=0,volume={}",
      inputs.len(),
      vec!["1"; inputs.len()].join(" "),
      1.0_f32 / inputs.len() as f32
    ));
  }

  args.extend([
    "-ac".to_owned(),
    DEFAULT_CHANNELS.to_string(),
    "-ar".to_owned(),
    DEFAULT_SAMPLE_RATE.to_string(),
    "-f".to_owned(),
    "f32le".to_owned(),
    "pipe:1".to_owned(),
  ]);

  args
}

fn build_capture_args() -> Result<Vec<String>> {
  let monitor_source = resolve_monitor_source()?;
  let microphone_source = resolve_microphone_source()?;

  Ok(build_capture_args_for_sources(
    &mut vec![monitor_source],
    Some(microphone_source),
  ))
}

fn build_monitor_only_capture_args(monitor_source: &str) -> Vec<String> {
  vec![
    "-hide_banner".to_owned(),
    "-loglevel".to_owned(),
    "error".to_owned(),
    "-nostdin".to_owned(),
    "-f".to_owned(),
    "pulse".to_owned(),
    "-i".to_owned(),
    monitor_source.to_owned(),
    "-ac".to_owned(),
    DEFAULT_CHANNELS.to_string(),
    "-ar".to_owned(),
    DEFAULT_SAMPLE_RATE.to_string(),
    "-f".to_owned(),
    "f32le".to_owned(),
    "pipe:1".to_owned(),
  ]
}

fn start_recording_with_args(
  feature: &str,
  ffmpeg_args: Vec<String>,
  audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
  routing: Option<LinuxCaptureRouting>,
) -> Result<AudioCaptureSession> {
  let mut child = Command::new("ffmpeg")
    .args(ffmpeg_args.iter())
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|err| linux_backend_error(feature, format!("Failed to launch ffmpeg: {err}")))?;

  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| linux_backend_error(feature, "ffmpeg stdout was not captured."))?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| linux_backend_error(feature, "ffmpeg stderr was not captured."))?;

  let child_handle = Arc::new(Mutex::new(child));
  let stopped = Arc::new(AtomicBool::new(false));
  let stderr_buffer = Arc::new(Mutex::new(String::new()));

  let stderr_buffer_for_thread = stderr_buffer.clone();
  let stderr_thread = thread::spawn(move || {
    let mut reader = BufReader::new(stderr);
    let mut captured = String::new();
    let _ = reader.read_to_string(&mut captured);
    if let Ok(mut buffer) = stderr_buffer_for_thread.lock() {
      *buffer = captured;
    }
  });

  let callback = Arc::new(audio_stream_callback);
  let callback_for_thread = callback.clone();
  let stopped_for_thread = stopped.clone();
  let child_for_thread = child_handle.clone();
  let stderr_for_thread = stderr_buffer.clone();
  let feature_for_thread = feature.to_owned();

  let stdout_thread = thread::spawn(move || {
    let mut reader = BufReader::new(stdout);
    let mut pending = Vec::new();
    let mut chunk = [0_u8; 8_192];

    loop {
      match reader.read(&mut chunk) {
        Ok(0) => break,
        Ok(bytes_read) => {
          if stopped_for_thread.load(Ordering::SeqCst) {
            continue;
          }

          pending.extend_from_slice(&chunk[..bytes_read]);
          let complete_length = pending.len() - (pending.len() % 4);
          if complete_length == 0 {
            continue;
          }

          let complete_bytes = pending.drain(..complete_length).collect::<Vec<_>>();
          let samples = complete_bytes
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect::<Vec<_>>();

          if !samples.is_empty() {
            let _ =
              callback_for_thread.call(Ok(samples.into()), ThreadsafeFunctionCallMode::NonBlocking);
          }
        }
        Err(err) => {
          if !stopped_for_thread.load(Ordering::SeqCst) {
            let _ = callback_for_thread.call(
              Err(linux_backend_error(
                &feature_for_thread,
                format!("Failed to read ffmpeg output: {err}"),
              )),
              ThreadsafeFunctionCallMode::NonBlocking,
            );
          }
          return;
        }
      }
    }

    let exit_status = child_for_thread
      .lock()
      .ok()
      .and_then(|mut child| child.wait().ok());
    if stopped_for_thread.load(Ordering::SeqCst) {
      return;
    }

    if let Some(status) = exit_status
      && status.success()
    {
      return;
    }

    let stderr = stderr_for_thread
      .lock()
      .map(|buffer| buffer.trim().to_owned())
      .unwrap_or_default();
    let detail = if !stderr.is_empty() {
      stderr
    } else if let Some(status) = exit_status {
      if let Some(code) = status.code() {
        format!("ffmpeg exited with {code}")
      } else {
        "ffmpeg exited unexpectedly".to_owned()
      }
    } else {
      "ffmpeg exited unexpectedly".to_owned()
    };

    let _ = callback_for_thread.call(
      Err(linux_backend_error(&feature_for_thread, detail)),
      ThreadsafeFunctionCallMode::NonBlocking,
    );
  });

  Ok(AudioCaptureSession {
    child: Some(child_handle),
    stdout_thread: Some(stdout_thread),
    stderr_thread: Some(stderr_thread),
    stopped,
    sample_rate: DEFAULT_SAMPLE_RATE as f64,
    channels: DEFAULT_CHANNELS,
    routing,
  })
}

fn start_recording(
  audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
) -> Result<AudioCaptureSession> {
  start_recording_with_args(
    CAPTURE_FEATURE,
    build_capture_args()?,
    audio_stream_callback,
    None,
  )
}

fn start_process_recording(
  process_id: i32,
  audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
) -> Result<AudioCaptureSession> {
  let routing = ProcessTapRouting::start(process_id)?;
  let ffmpeg_args = build_monitor_only_capture_args(&format!("{}.monitor", routing.capture_sink));
  start_recording_with_args(
    PROCESS_CAPTURE_FEATURE,
    ffmpeg_args,
    audio_stream_callback,
    Some(LinuxCaptureRouting::Process(routing)),
  )
}

fn start_global_recording_with_exclusions(
  excluded_process_ids: HashSet<i32>,
  audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
) -> Result<AudioCaptureSession> {
  let routing = GlobalExcludedTapRouting::start(excluded_process_ids)?;
  let microphone_source = resolve_microphone_source()?;
  let mut monitor_sources = vec![format!("{}.monitor", routing.capture_sink)];
  let ffmpeg_args = build_capture_args_for_sources(&mut monitor_sources, Some(microphone_source));
  start_recording_with_args(
    CAPTURE_FEATURE,
    ffmpeg_args,
    audio_stream_callback,
    Some(LinuxCaptureRouting::GlobalExcluded(routing)),
  )
}

fn application_signature() -> Result<Vec<i32>> {
  let mut signature = parse_linux_process_list()?
    .into_iter()
    .map(|app| app.process_id)
    .collect::<Vec<_>>();
  signature.sort_unstable();
  Ok(signature)
}

#[napi]
#[derive(Clone)]
pub struct ApplicationInfo {
  pub process_id: i32,
  pub name: String,
  pub object_id: u32,
}

#[napi]
impl ApplicationInfo {
  #[napi(constructor)]
  pub fn new(process_id: i32, name: String, object_id: u32) -> Self {
    Self {
      process_id,
      name,
      object_id,
    }
  }

  #[napi(getter)]
  pub fn process_group_id(&self) -> i32 {
    let process_group_id = unsafe { libc::getpgid(self.process_id) };
    if process_group_id == -1 {
      self.process_id
    } else {
      process_group_id
    }
  }

  #[napi(getter)]
  pub fn bundle_identifier(&self) -> String {
    read_executable_path(self.process_id)
  }

  #[napi(getter)]
  pub fn icon(&self) -> Buffer {
    Buffer::from(Vec::<u8>::new())
  }
}

#[napi]
pub struct ApplicationListChangedSubscriber {
  stop_flag: Arc<AtomicBool>,
  _callback: Arc<ThreadsafeFunction<(), ()>>,
}

#[napi]
impl ApplicationListChangedSubscriber {
  #[napi]
  pub fn unsubscribe(&self) {
    self.stop_flag.store(true, Ordering::Relaxed);
  }
}

impl Drop for ApplicationListChangedSubscriber {
  fn drop(&mut self) {
    self.stop_flag.store(true, Ordering::Relaxed);
  }
}

#[napi]
pub struct ApplicationStateChangedSubscriber {
  stop_flag: Arc<AtomicBool>,
  _callback: Arc<ThreadsafeFunction<(), ()>>,
}

#[napi]
impl ApplicationStateChangedSubscriber {
  #[napi]
  pub fn unsubscribe(&self) {
    self.stop_flag.store(true, Ordering::Relaxed);
  }
}

impl Drop for ApplicationStateChangedSubscriber {
  fn drop(&mut self) {
    self.stop_flag.store(true, Ordering::Relaxed);
  }
}

#[napi]
pub struct AudioCaptureSession {
  child: Option<Arc<Mutex<Child>>>,
  stdout_thread: Option<JoinHandle<()>>,
  stderr_thread: Option<JoinHandle<()>>,
  stopped: Arc<AtomicBool>,
  sample_rate: f64,
  channels: u32,
  routing: Option<LinuxCaptureRouting>,
}

#[napi]
impl AudioCaptureSession {
  #[napi(getter)]
  pub fn get_sample_rate(&self) -> f64 {
    self.sample_rate
  }

  #[napi(getter)]
  pub fn get_channels(&self) -> u32 {
    self.channels
  }

  #[napi(getter)]
  pub fn get_actual_sample_rate(&self) -> f64 {
    self.sample_rate
  }

  #[napi]
  pub fn stop(&mut self) -> Result<()> {
    if self.stopped.swap(true, Ordering::SeqCst) {
      return Ok(());
    }

    if let Some(child_handle) = &self.child
      && let Ok(mut child) = child_handle.lock()
    {
      match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
          unsafe {
            libc::kill(child.id() as i32, libc::SIGINT);
          }

          let deadline = Instant::now() + Duration::from_secs(1);
          loop {
            match child.try_wait() {
              Ok(Some(_)) => break,
              Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
              }
              Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break;
              }
            }
          }
        }
        Err(_) => {}
      }
    }

    if let Some(handle) = self.stdout_thread.take() {
      let _ = handle.join();
    }

    if let Some(handle) = self.stderr_thread.take() {
      let _ = handle.join();
    }

    if let Some(routing) = self.routing.take() {
      match routing {
        LinuxCaptureRouting::Process(mut routing) => routing.cleanup(),
        LinuxCaptureRouting::GlobalExcluded(mut routing) => routing.cleanup(),
      }
    }

    self.child = None;
    Ok(())
  }
}

impl Drop for AudioCaptureSession {
  fn drop(&mut self) {
    let _ = self.stop();
  }
}

#[napi]
pub struct ShareableContent {}

#[napi]
impl ShareableContent {
  #[napi]
  pub fn on_application_list_changed(
    callback: ThreadsafeFunction<(), ()>,
  ) -> Result<ApplicationListChangedSubscriber> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let callback_arc = Arc::new(callback);
    let stop_flag_for_thread = stop_flag.clone();
    let callback_for_thread = callback_arc.clone();

    thread::spawn(move || {
      let mut previous_signature = match application_signature() {
        Ok(signature) => signature,
        Err(err) => {
          let _ = callback_for_thread.call(Err(err), ThreadsafeFunctionCallMode::NonBlocking);
          Vec::new()
        }
      };

      while !stop_flag_for_thread.load(Ordering::Relaxed) {
        thread::sleep(POLL_INTERVAL);
        if stop_flag_for_thread.load(Ordering::Relaxed) {
          break;
        }

        match application_signature() {
          Ok(current_signature) => {
            if current_signature != previous_signature {
              previous_signature = current_signature;
              let _ = callback_for_thread.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
            }
          }
          Err(err) => {
            let _ = callback_for_thread.call(Err(err), ThreadsafeFunctionCallMode::NonBlocking);
          }
        }
      }
    });

    Ok(ApplicationListChangedSubscriber {
      stop_flag,
      _callback: callback_arc,
    })
  }

  #[napi]
  pub fn on_app_state_changed(
    app: &ApplicationInfo,
    callback: ThreadsafeFunction<(), ()>,
  ) -> Result<ApplicationStateChangedSubscriber> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let callback_arc = Arc::new(callback);
    let stop_flag_for_thread = stop_flag.clone();
    let callback_for_thread = callback_arc.clone();
    let process_id = app.process_id as u32;

    thread::spawn(move || {
      let mut previous_is_using_microphone = match ShareableContent::is_using_microphone(process_id)
      {
        Ok(is_using_microphone) => is_using_microphone,
        Err(err) => {
          let _ = callback_for_thread.call(Err(err), ThreadsafeFunctionCallMode::NonBlocking);
          false
        }
      };

      while !stop_flag_for_thread.load(Ordering::Relaxed) {
        thread::sleep(POLL_INTERVAL);
        if stop_flag_for_thread.load(Ordering::Relaxed) {
          break;
        }

        match ShareableContent::is_using_microphone(process_id) {
          Ok(current_is_using_microphone) => {
            if current_is_using_microphone != previous_is_using_microphone {
              previous_is_using_microphone = current_is_using_microphone;
              let _ = callback_for_thread.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
            }
          }
          Err(err) => {
            let _ = callback_for_thread.call(Err(err), ThreadsafeFunctionCallMode::NonBlocking);
          }
        }
      }
    });

    Ok(ApplicationStateChangedSubscriber {
      stop_flag,
      _callback: callback_arc,
    })
  }

  #[napi(constructor)]
  pub fn new() -> Self {
    Self {}
  }

  #[napi]
  pub fn applications() -> Result<Vec<ApplicationInfo>> {
    parse_linux_process_list()
  }

  #[napi]
  pub fn application_with_process_id(process_id: u32) -> Option<ApplicationInfo> {
    parse_linux_process_list()
      .ok()?
      .into_iter()
      .find(|app| app.process_id == process_id as i32)
  }

  #[napi]
  pub fn is_using_microphone(process_id: u32) -> Result<bool> {
    Ok(read_active_microphone_process_ids()?.contains(&(process_id as i32)))
  }

  #[napi]
  pub fn tap_audio(
    process_id: u32,
    audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
  ) -> Result<AudioCaptureSession> {
    start_process_recording(process_id as i32, audio_stream_callback)
  }

  #[napi]
  pub fn tap_global_audio(
    excluded_processes: Option<Vec<&ApplicationInfo>>,
    audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
  ) -> Result<AudioCaptureSession> {
    let excluded_process_ids = excluded_processes
      .unwrap_or_default()
      .into_iter()
      .map(|application| application.process_id)
      .collect::<HashSet<_>>();

    if excluded_process_ids.is_empty() {
      return start_recording(audio_stream_callback);
    }

    start_global_recording_with_exclusions(excluded_process_ids, audio_stream_callback)
  }
}
