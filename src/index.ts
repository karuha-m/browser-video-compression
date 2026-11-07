import {
  ALL_FORMATS,
  type AudioCodec,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  type Quality,
  type VideoCodec,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';

export type OutputFormat = 'mp4' | 'webm';
export type CompressionQuality = 'low' | 'medium' | 'high';

export interface CompressVideoOptions {
  /**
   * Longest edge of the output video, in pixels. Videos that are already
   * smaller keep their original dimensions. Default: `1280` (720p).
   */
  maxWidthOrHeight?: number;
  /**
   * Files at or below this size (in MB) whose dimensions already fit within
   * `maxWidthOrHeight` are returned unchanged. Default: no threshold.
   */
  skipBelowMB?: number;
  /** Subjective quality preset. Ignored when `videoBitrate` is set. Default: `'medium'`. */
  quality?: CompressionQuality;
  /** Target video bitrate in bits per second. Overrides `quality`. */
  videoBitrate?: number;
  /** Audio bitrate in bits per second, used only when audio must be re-encoded. Default: `128000`. */
  audioBitrate?: number;
  /** Output frame rate cap in Hz. Default: keep the source frame rate. */
  maxFrameRate?: number;
  /** Output container. `'mp4'` produces H.264 + AAC; `'webm'` produces VP9/VP8 + Opus. Default: `'mp4'`. */
  format?: OutputFormat;
  /** Called with a value between 0 and 1 while the video is being compressed. */
  onProgress?: (progress: number) => void;
  /** Aborts the compression. The returned promise rejects with an `AbortError`. */
  signal?: AbortSignal;
  /**
   * Some hardware encoders stop producing output without reporting an error.
   * When progress does not advance for this long while the page is visible,
   * compression is cancelled and the original file is returned. Default: `90000`.
   */
  stallTimeoutMs?: number;
}

export type SkipReason =
  /** The file is already below `skipBelowMB` and within `maxWidthOrHeight`. */
  | 'already-small'
  /** This browser has no WebCodecs encoder for the requested output. */
  | 'unsupported-browser'
  /** The file has no video track or its video cannot be decoded in this browser. */
  | 'unsupported-input'
  /** The compressed result was not smaller than the original. */
  | 'not-smaller'
  /** Compression started but failed; see `error`. */
  | 'failed';

export interface CompressVideoResult {
  /** The file to upload: the compressed file, or the original when compression was skipped. */
  file: File;
  /** `true` when `file` is the compressed output. */
  compressed: boolean;
  /** Why the original file was returned. Present only when `compressed` is `false`. */
  skipReason?: SkipReason;
  /** The underlying error when `skipReason` is `'failed'`. */
  error?: unknown;
  /** Size of the input file in bytes. */
  originalSize: number;
  /** Size of `file` in bytes. */
  size: number;
  /** Display width of `file` in pixels, when known. */
  width?: number;
  /** Display height of `file` in pixels, when known. */
  height?: number;
  /** Duration in seconds, when known. */
  duration?: number;
}

export interface VideoInfo {
  /** File size in bytes. */
  size: number;
  /** MIME type of the container, e.g. `video/mp4`. */
  mimeType: string;
  /** Duration in seconds. */
  duration: number;
  /** Display width in pixels (after rotation metadata is applied). */
  width: number;
  /** Display height in pixels (after rotation metadata is applied). */
  height: number;
  /** Video codec, e.g. `avc`, `hevc`, `vp9`, or `null` when unknown. */
  videoCodec: string | null;
  /** Audio codec of the primary audio track, or `null` when there is no audio. */
  audioCodec: string | null;
  /** Average overall bitrate in bits per second (`size * 8 / duration`). */
  bitrate: number;
  /** Whether this browser can decode the video track. */
  canDecode: boolean;
}

const QUALITY_PRESETS: Record<CompressionQuality, Quality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
};

const VIDEO_CODECS: Record<OutputFormat, VideoCodec[]> = {
  mp4: ['avc'],
  webm: ['vp9', 'vp8'],
};

const AUDIO_CODEC: Record<OutputFormat, AudioCodec> = {
  mp4: 'aac',
  webm: 'opus',
};

const COPYABLE_AUDIO: Record<OutputFormat, string[]> = {
  mp4: ['aac'],
  webm: ['opus', 'vorbis'],
};

const MB = 1024 * 1024;
const STALL_CHECK_INTERVAL_MS = 5_000;

class StalledError extends Error {
  constructor(idleMs: number) {
    super(`Encoder produced no progress for ${Math.round(idleMs / 1000)} s`);
    this.name = 'StalledError';
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** Rounds down to an even number; most H.264 encoders reject odd dimensions. */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: even(Math.round(width * scale)),
    height: even(Math.round(height * scale)),
  };
}

function renameFile(name: string, format: OutputFormat): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'video';
  return `${base}.${format}`;
}

function toFile(blob: Blob): File {
  if (blob instanceof File) return blob;
  return new File([blob], 'video', { type: blob.type });
}

/**
 * Returns `true` when this browser exposes the WebCodecs APIs needed for
 * compression and can encode H.264 (or VP9/VP8 for `'webm'`).
 */
export async function isCompressionSupported(
  format: OutputFormat = 'mp4',
): Promise<boolean> {
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoDecoder === 'undefined'
  ) {
    return false;
  }
  for (const codec of VIDEO_CODECS[format]) {
    if (await canEncodeVideo(codec)) return true;
  }
  return false;
}

/**
 * Reads container metadata without decoding the whole file. Use it to
 * validate duration, resolution or codec before uploading.
 */
export async function inspectVideo(file: Blob): Promise<VideoInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error('The file has no video track');
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const canDecode =
      typeof VideoDecoder !== 'undefined' && (await videoTrack.canDecode());
    return {
      size: file.size,
      mimeType: await input.getMimeType(),
      duration,
      width: videoTrack.displayWidth,
      height: videoTrack.displayHeight,
      videoCodec: videoTrack.codec,
      audioCodec: audioTrack?.codec ?? null,
      bitrate: duration > 0 ? Math.round((file.size * 8) / duration) : 0,
      canDecode,
    };
  } finally {
    input.dispose();
  }
}

async function pickVideoCodec(
  format: OutputFormat,
  config: { width: number; height: number; bitrate: number | Quality },
): Promise<
  | { codec: VideoCodec; hardwareAcceleration?: 'prefer-software' }
  | undefined
> {
  for (const codec of VIDEO_CODECS[format]) {
    if (await canEncodeVideo(codec, config)) return { codec };
    // Some hardware encoders reject a size or bitrate the software encoder accepts.
    if (
      await canEncodeVideo(codec, {
        ...config,
        hardwareAcceleration: 'prefer-software',
      })
    ) {
      return { codec, hardwareAcceleration: 'prefer-software' };
    }
  }
  return undefined;
}

async function runConversion(
  conversion: Conversion,
  options: {
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
    stallTimeoutMs: number;
  },
): Promise<void> {
  const { signal, stallTimeoutMs } = options;
  let idleMs = 0;
  let lastTick = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let onAbort: (() => void) | undefined;

  conversion.onProgress = (progress) => {
    idleMs = 0;
    options.onProgress?.(progress);
  };

  const guard = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      const now = Date.now();
      // Background tabs throttle timers; cap the delta so one late tick is not read as a stall.
      const delta = Math.min(now - lastTick, STALL_CHECK_INTERVAL_MS * 2);
      lastTick = now;
      if (
        typeof document !== 'undefined' &&
        document.visibilityState !== 'visible'
      ) {
        return;
      }
      idleMs += delta;
      if (idleMs < stallTimeoutMs) return;
      // A stalled encoder may never acknowledge cancel(); do not wait for it.
      void conversion.cancel().catch(() => undefined);
      reject(new StalledError(idleMs));
    }, STALL_CHECK_INTERVAL_MS);

    if (signal) {
      onAbort = () => {
        void conversion.cancel().catch(() => undefined);
        reject(abortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    await Promise.race([conversion.execute(), guard]);
  } finally {
    clearInterval(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Compresses a video in the browser before upload.
 *
 * The promise never rejects because of an encoding problem: when the browser
 * cannot compress the file, or the result would not be smaller, the original
 * file is returned with `compressed: false` and a `skipReason`, so the upload
 * can always proceed. It rejects only when `signal` is aborted.
 */
export async function compressVideo(
  source: File | Blob,
  options: CompressVideoOptions = {},
): Promise<CompressVideoResult> {
  const {
    maxWidthOrHeight = 1280,
    skipBelowMB,
    quality = 'medium',
    videoBitrate,
    audioBitrate = 128_000,
    maxFrameRate,
    format = 'mp4',
    onProgress,
    signal,
    stallTimeoutMs = 90_000,
  } = options;

  const original = toFile(source);
  const skip = (
    skipReason: SkipReason,
    extra: Partial<CompressVideoResult> = {},
  ): CompressVideoResult => ({
    file: original,
    compressed: false,
    skipReason,
    originalSize: original.size,
    size: original.size,
    ...extra,
  });

  if (signal?.aborted) throw abortError(signal);

  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoDecoder === 'undefined'
  ) {
    return skip('unsupported-browser');
  }

  const input = new Input({
    source: new BlobSource(original),
    formats: ALL_FORMATS,
  });

  try {
    let videoTrack: Awaited<ReturnType<Input['getPrimaryVideoTrack']>>;
    try {
      videoTrack = await input.getPrimaryVideoTrack();
    } catch (error) {
      return skip('unsupported-input', { error });
    }
    if (!videoTrack || !(await videoTrack.canDecode())) {
      return skip('unsupported-input');
    }

    const sourceWidth = videoTrack.displayWidth;
    const sourceHeight = videoTrack.displayHeight;
    const duration = await input.computeDuration();
    const sourceInfo = { width: sourceWidth, height: sourceHeight, duration };

    if (
      skipBelowMB !== undefined &&
      original.size <= skipBelowMB * MB &&
      Math.max(sourceWidth, sourceHeight) <= maxWidthOrHeight
    ) {
      return skip('already-small', sourceInfo);
    }

    const target = fitWithin(sourceWidth, sourceHeight, maxWidthOrHeight);
    const bitrate = videoBitrate ?? QUALITY_PRESETS[quality];
    const videoChoice = await pickVideoCodec(format, { ...target, bitrate });
    if (!videoChoice) {
      return skip('unsupported-browser', sourceInfo);
    }

    // Copy audio untouched when the container accepts it: re-encoding saves little
    // and some browsers ship no AAC encoder at all.
    const audioTracks = await input.getAudioTracks();
    const copyAudio = audioTracks.every(
      (track) =>
        track.codec !== null && COPYABLE_AUDIO[format].includes(track.codec),
    );
    if (
      !copyAudio &&
      !(await canEncodeAudio(AUDIO_CODEC[format], { bitrate: audioBitrate }))
    ) {
      // Dropping the soundtrack is never an acceptable trade for a smaller file.
      return skip('unsupported-browser', sourceInfo);
    }

    const firstTimestamp = await input.getFirstTimestamp();
    const output = new Output({
      format: format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat(),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      // AAC priming can make the first timestamp slightly negative; shifting the
      // start keeps audio copyable instead of forcing a re-encode.
      ...(firstTimestamp < 0 && { trim: { start: firstTimestamp } }),
      video: {
        codec: videoChoice.codec,
        bitrate,
        width: target.width,
        height: target.height,
        fit: 'contain',
        ...(videoChoice.hardwareAcceleration && {
          hardwareAcceleration: videoChoice.hardwareAcceleration,
        }),
        ...(maxFrameRate !== undefined && { frameRate: maxFrameRate }),
      },
      ...(!copyAudio && {
        audio: { codec: AUDIO_CODEC[format], bitrate: audioBitrate },
      }),
    });

    const keepsVideo = conversion.utilizedTracks.some((track) =>
      track.isVideoTrack(),
    );
    const keepsAudio =
      audioTracks.length === 0 ||
      conversion.utilizedTracks.some((track) => track.isAudioTrack());
    if (!conversion.isValid || !keepsVideo || !keepsAudio) {
      return skip('unsupported-input', sourceInfo);
    }

    try {
      await runConversion(conversion, { onProgress, signal, stallTimeoutMs });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      return skip('failed', { ...sourceInfo, error });
    }

    const buffer = output.target.buffer;
    if (!buffer) return skip('failed', sourceInfo);
    const blob = new Blob([buffer], { type: output.format.mimeType });

    // An encoder that emits no frames still yields a valid container; verify the result.
    const check = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const outputTrack = await check.getPrimaryVideoTrack();
      const outputDuration = outputTrack
        ? await check.computeDuration()
        : 0;
      if (!outputTrack || (duration >= 1 && outputDuration < duration * 0.5)) {
        return skip('failed', {
          ...sourceInfo,
          error: new Error('Compressed output is missing video frames'),
        });
      }
    } finally {
      check.dispose();
    }

    if (blob.size >= original.size) {
      return skip('not-smaller', sourceInfo);
    }

    const file = new File([blob], renameFile(original.name, format), {
      type: blob.type,
      lastModified: original.lastModified,
    });
    return {
      file,
      compressed: true,
      originalSize: original.size,
      size: file.size,
      width: target.width,
      height: target.height,
      duration,
    };
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    return skip('failed', { error });
  } finally {
    input.dispose();
  }
}
