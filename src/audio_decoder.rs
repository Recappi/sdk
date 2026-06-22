use std::{io::Cursor, path::Path};

use audioadapter_buffers::direct::SequentialSliceOfVecs;
use napi::{
  Task,
  bindgen_prelude::{AbortSignal, AsyncTask, Float32Array, Result, Status, Uint8Array},
};
use napi_derive::napi;
use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType};
use symphonia::core::{
  codecs::audio::AudioDecoderOptions,
  errors::Error,
  formats::{FormatOptions, TrackType, probe::Hint},
  io::MediaSourceStream,
  meta::MetadataOptions,
};

fn decode<B: AsRef<[u8]> + Send + Sync + 'static>(
  buf: B,
  dest_sample_rate: Option<u32>,
  filename: Option<&str>,
) -> std::result::Result<Vec<f32>, Error> {
  // Create the media source
  let mss = MediaSourceStream::new(Box::new(Cursor::new(buf)), Default::default());

  // Create a probe hint using the file extension
  let mut hint = Hint::new();
  if let Some(ext) =
    filename.and_then(|filename| Path::new(filename).extension().and_then(|ext| ext.to_str()))
  {
    hint.with_extension(ext);
  }

  // Gapless playback moved from `FormatOptions` to `AudioDecoderOptions` in
  // symphonia 0.6, where it defaults to `true` (the old `enable_gapless: true`).
  let format_opts = FormatOptions::default();
  let metadata_opts = MetadataOptions::default();
  let decoder_opts = AudioDecoderOptions::default();
  // `Probe::format` was renamed to `Probe::probe` and now takes the options by
  // value and returns the `FormatReader` directly (no `ProbedFormat` wrapper).
  let mut format = symphonia::default::get_probe().probe(&hint, mss, format_opts, metadata_opts)?;

  let track = format
    .default_track(TrackType::Audio)
    .ok_or(Error::Unsupported("No default track found"))?;

  // `n_frames` moved onto `Track` (renamed `num_frames`); `sample_rate` now
  // lives on the audio codec parameters.
  let totol_samples = track
    .num_frames
    .ok_or(Error::Unsupported("No duration found"))?;
  let audio_params = track
    .codec_params
    .as_ref()
    .and_then(|params| params.audio())
    .ok_or(Error::Unsupported("No audio codec params found"))?;
  let sample_rate = audio_params
    .sample_rate
    .ok_or(Error::Unsupported("No samplerate found"))?;

  let track_id = track.id;
  // `CodecRegistry::make` was replaced by `make_audio_decoder`, which takes the
  // audio-specific codec parameters.
  let mut decoder =
    symphonia::default::get_codecs().make_audio_decoder(audio_params, &decoder_opts)?;

  let mut output: Vec<f32> = Vec::with_capacity(totol_samples as usize);
  let mut planes: Vec<Vec<f32>> = Vec::new();
  let mut interleaved: Vec<f32> = Vec::new();
  // Decode loop. `next_packet` now returns `Result<Option<Packet>>`; `Ok(None)`
  // signals end-of-stream, and packets may belong to other tracks.
  loop {
    let packet = match format.next_packet() {
      Ok(Some(packet)) => packet,
      Ok(None) => break,
      Err(Error::ResetRequired) => break,
      Err(err) => return Err(err),
    };

    if packet.track_id != track_id {
      continue;
    }

    // Abort on any decode error (matches the pre-0.6 `decoder.decode(&packet)?`
    // behavior). A corrupt or truncated stream must fail loudly rather than
    // silently returning partial/empty PCM.
    let decoded = decoder.decode(&packet)?;

    let channels = decoded.spec().channels().count();

    if channels > 1 {
      // Mix all channels into mono. `copy_to_vecs_planar` converts each plane to
      // f32 (replacing the old `AudioBuffer::convert` + `chan(i)` accessors).
      decoded.copy_to_vecs_planar(&mut planes);
      let frames = decoded.frames();
      for i in 0..frames {
        let mut sample_sum = 0.0;
        for plane in planes.iter().take(channels) {
          sample_sum += plane[i];
        }
        output.push(sample_sum / channels as f32);
      }
    } else {
      decoded.copy_to_vec_interleaved(&mut interleaved);
      output.extend_from_slice(&interleaved);
    }
  }

  let Some(dest_sample_rate) = dest_sample_rate else {
    return Ok(output);
  };

  if sample_rate != dest_sample_rate {
    let params = SincInterpolationParameters {
      sinc_len: 256,
      f_cutoff: 0.95,
      interpolation: SincInterpolationType::Linear,
      oversampling_factor: 256,
      window: rubato::WindowFunction::BlackmanHarris2,
    };

    let num_frames = output.len();
    let mut resampler = Async::<f32>::new_sinc(
      dest_sample_rate as f64 / sample_rate as f64,
      2.0,
      &params,
      num_frames,
      1,
      FixedAsync::Input,
    )
    .map_err(|_| Error::Unsupported("Failed to create resampler"))?;

    let waves_in = vec![output];
    let output_frames = resampler.output_frames_next();
    let input_adapter = SequentialSliceOfVecs::new(&waves_in, 1, num_frames)
      .map_err(|_| Error::Unsupported("Failed to create input adapter"))?;
    let mut waves_out = vec![vec![0.0f32; output_frames]];
    let mut output_adapter = SequentialSliceOfVecs::new_mut(&mut waves_out, 1, output_frames)
      .map_err(|_| Error::Unsupported("Failed to create output adapter"))?;
    resampler
      .process_into_buffer(&input_adapter, &mut output_adapter, None)
      .map_err(|_| Error::Unsupported("Failed to run resampler"))?;
    output = waves_out
      .pop()
      .ok_or(Error::Unsupported("No resampled output found"))?;
  }

  Ok(output)
}

#[napi]
/// Decode audio file into a Float32Array
pub fn decode_audio_sync(
  buf: Uint8Array,
  dest_sample_rate: Option<u32>,
  filename: Option<String>,
) -> Result<Float32Array> {
  decode(buf, dest_sample_rate, filename.as_deref())
    .map(Float32Array::new)
    .map_err(|e| {
      napi::Error::new(
        Status::InvalidArg,
        format!("Decode audio into Float32Array failed: {e}"),
      )
    })
}

pub struct DecodeAudioTask {
  buf: Uint8Array,
  dest_sample_rate: Option<u32>,
  filename: Option<String>,
}

#[napi]
impl Task for DecodeAudioTask {
  type Output = Vec<f32>;
  type JsValue = Float32Array;

  fn compute(&mut self) -> Result<Self::Output> {
    decode(
      std::mem::replace(&mut self.buf, Uint8Array::new(vec![])),
      self.dest_sample_rate,
      self.filename.as_deref(),
    )
    .map_err(|e| {
      napi::Error::new(
        Status::InvalidArg,
        format!("Decode audio into Float32Array failed: {e}"),
      )
    })
  }

  fn resolve(&mut self, _: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(Float32Array::new(output))
  }
}

#[napi]
pub fn decode_audio(
  buf: Uint8Array,
  dest_sample_rate: Option<u32>,
  filename: Option<String>,
  signal: Option<AbortSignal>,
) -> AsyncTask<DecodeAudioTask> {
  AsyncTask::with_optional_signal(
    DecodeAudioTask {
      buf,
      dest_sample_rate,
      filename,
    },
    signal,
  )
}

#[cfg(test)]
mod tests {
  use super::decode;

  fn create_pcm_wav(samples: &[i16], channels: u16, sample_rate: u32) -> Vec<u8> {
    let bits_per_sample = 16u16;
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_size = std::mem::size_of_val(samples) as u32;
    let riff_chunk_size = 36 + data_size;

    let mut wav = Vec::with_capacity((44 + data_size) as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for sample in samples {
      wav.extend_from_slice(&sample.to_le_bytes());
    }

    wav
  }

  fn assert_close(actual: f32, expected: f32, tolerance: f32) {
    assert!(
      (actual - expected).abs() <= tolerance,
      "expected {expected}, got {actual} (tolerance {tolerance})"
    );
  }

  #[test]
  fn test_decode_stereo_wav_mixes_channels_to_mono() {
    let wav = create_pcm_wav(
      &[
        8192, 8192, // 0.25 + 0.25 -> 0.25
        16384, 0, // 0.5 + 0.0 -> 0.25
        0, 0, // silence
      ],
      2,
      48_000,
    );

    let decoded = decode(wav, None, Some("fixture.wav")).expect("decode should succeed");

    assert_eq!(decoded.len(), 3);
    assert_close(decoded[0], 0.25, 0.01);
    assert_close(decoded[1], 0.25, 0.01);
    assert_close(decoded[2], 0.0, 0.001);
  }

  #[test]
  fn test_decode_resamples_when_destination_sample_rate_changes() {
    let input = vec![4096i16; 480];
    let wav = create_pcm_wav(&input, 1, 48_000);

    let decoded =
      decode(wav, Some(24_000), Some("fixture.wav")).expect("decode with resample should succeed");

    assert!(
      (decoded.len() as isize - 240).abs() <= 2,
      "expected decoded length to be close to 240, got {}",
      decoded.len()
    );
    assert_close(decoded[decoded.len() / 2], 0.125, 0.05);
  }
}
