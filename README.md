# browser-video-compression

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Compress videos in the browser before they are uploaded. Built on [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) through [Mediabunny](https://mediabunny.dev): no server round trip, no ffmpeg.wasm download, and hardware-accelerated encoding where the device supports it.

A 1080p phone recording usually becomes a 720p H.264 file that is 60–90% smaller, so uploads finish sooner, fail less often on mobile networks, and cost less to store.

Documentation: [videokit.cc/en/browser-video-compression](https://www.videokit.cc/en/browser-video-compression)

## Features

- **Upload-safe by design.** `compressVideo()` never blocks an upload: if the browser cannot encode, the input cannot be decoded, or the result would not be smaller, you get the original file back with a `skipReason`.
- **Resize and re-encode** to H.264 + AAC in MP4 (or VP9 + Opus in WebM), keeping the aspect ratio and rotation.
- **Audio is copied untouched** when the container accepts it, so the soundtrack is never degraded or dropped.
- **Preflight checks** with `inspectVideo()`: duration, resolution, codecs and bitrate read from container metadata, without decoding the file.
- **Progress, cancellation and stall detection**: `onProgress`, `AbortSignal`, and a watchdog for hardware encoders that stop producing frames without an error.
- **Output streamed to disk.** Where the browser supports the Origin Private File System (OPFS), the compressed file is written to disk as it is encoded instead of being held in memory, and stays there until you call `result.dispose()`.
- **Tree-shakable ESM with TypeScript types.** No cross-origin isolation (COOP/COEP) headers required.

## Demo

[VideoKit's online video compressor](https://www.videokit.cc/en/video-compressor) runs the same in-browser approach on files of several gigabytes.

To try this package locally: clone the repository, run `npm install && npm run build`, serve the repository root (for example `npx serve .`) and open `/examples/index.html`.

## Install

```bash
npm install https://github.com/karuha-m/browser-video-compression/releases/download/v0.2.0/browser-video-compression-0.2.0.tgz
```

The release tarball contains the built package and installs the same way with npm, pnpm, Yarn and Bun. The import name is `browser-video-compression`.

With npm you can also install straight from the repository (`npm install github:karuha-m/browser-video-compression`); npm builds it on install through `prepare`. Bun does not run `prepare` for Git dependencies, so use the release tarball there.

## Usage

```html
<input type="file" accept="video/*" id="video" />
```

```js
import { compressVideo } from 'browser-video-compression';

document.getElementById('video').addEventListener('change', async (event) => {
  const original = event.target.files[0];

  const result = await compressVideo(original, {
    maxWidthOrHeight: 1280, // 720p
    skipBelowMB: 10, // small files are uploaded as they are
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  });

  console.log(
    result.compressed
      ? `${result.originalSize} → ${result.size} bytes`
      : `uploading original (${result.skipReason})`,
  );

  try {
    const body = new FormData();
    body.append('video', result.file);
    await fetch('/upload', { method: 'POST', body });
  } finally {
    await result.dispose(); // delete the compressed file once the upload has settled
  }
});
```

### Releasing the output

When OPFS is available (`result.storage === 'opfs'`), `result.file` is backed by a file in the browser's private storage. It stays readable for as long as you need it, so a queued upload or a retried chunk can read it again later. Call `result.dispose()` once the upload has succeeded or been abandoned; after that `result.file` can no longer be read.

If the tab is closed before `dispose()` is called, the file is removed the next time `compressVideo()` runs in any tab of the same origin. Results that are still alive in another tab are never touched. Outputs held in memory (`storage: 'memory'`) are released by the garbage collector, and `dispose()` does nothing for them; calling it is always safe.

### With an upload library

`result.file` is a regular `File`, so it can be handed to any uploader: tus, Uppy, S3 presigned URLs, Mux / Cloudflare Stream direct uploads.

```js
import * as tus from 'tus-js-client';

const result = await compressVideo(original);
new tus.Upload(result.file, {
  endpoint: '/files/',
  onSuccess: () => result.dispose(),
}).start();
```

### Cancelling

```js
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

try {
  const result = await compressVideo(file, { signal: controller.signal });
} catch (error) {
  if (error.name === 'AbortError') return; // user cancelled
  throw error;
}
```

### Preflight checks

```js
import { inspectVideo } from 'browser-video-compression';

const info = await inspectVideo(file);
if (info.duration > 600) {
  alert('Please upload a video shorter than 10 minutes.');
}
```

## API

### `compressVideo(file, options?) => Promise<CompressVideoResult>`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxWidthOrHeight` | `number` | `1280` | Longest edge of the output in pixels. Smaller videos keep their size. |
| `skipBelowMB` | `number` | – | Return files at or below this size unchanged, provided they already fit `maxWidthOrHeight`. |
| `quality` | `'low' \| 'medium' \| 'high'` | `'medium'` | Bitrate preset, scaled to the output resolution. |
| `videoBitrate` | `number` | – | Video bitrate in bits per second. Overrides `quality`. |
| `audioBitrate` | `number` | `128000` | Used only when audio has to be re-encoded. |
| `maxFrameRate` | `number` | source | Output frame rate in Hz. |
| `format` | `'mp4' \| 'webm'` | `'mp4'` | `mp4` = H.264 + AAC, `webm` = VP9/VP8 + Opus. |
| `onProgress` | `(progress: number) => void` | – | Progress between 0 and 1. |
| `signal` | `AbortSignal` | – | Cancels compression; the promise rejects with `AbortError`. |
| `stallTimeoutMs` | `number` | `90000` | Gives up (and returns the original) when the encoder makes no progress for this long while the page is visible. |
| `storage` | `'auto' \| 'memory'` | `'auto'` | `auto` streams the output to OPFS when available and falls back to memory; `memory` always keeps it in memory. |

`CompressVideoResult`:

| Field | Type | Description |
| --- | --- | --- |
| `file` | `File` | The file to upload: compressed output or the original. |
| `compressed` | `boolean` | `true` when `file` is the compressed output. |
| `skipReason` | `'already-small' \| 'unsupported-browser' \| 'unsupported-input' \| 'not-smaller' \| 'failed'` | Why the original was returned. |
| `error` | `unknown` | Underlying error when `skipReason` is `'failed'`. |
| `originalSize` / `size` | `number` | Bytes before and after. |
| `width` / `height` / `duration` | `number` | Output dimensions in pixels and duration in seconds, when known. |
| `storage` | `'opfs' \| 'memory'` | Where the compressed `file` is stored. Present only when `compressed` is `true`. |
| `dispose` | `() => Promise<void>` | Deletes the compressed output from OPFS. Call it after the upload has settled. Safe to call more than once. |

The promise rejects only when `signal` is aborted.

### `inspectVideo(file) => Promise<VideoInfo>`

Returns `{ size, mimeType, duration, width, height, videoCodec, audioCodec, bitrate, canDecode }`. Throws when the file has no video track or the container is not recognised.

### `isCompressionSupported(format?) => Promise<boolean>`

`true` when WebCodecs is available and an encoder for the given format (`'mp4'` by default) exists. Useful for deciding whether to show a "compressing…" step at all.

## Browser support

| Browser | Status |
| --- | --- |
| Chrome / Edge 94+ (desktop and Android) | Supported |
| Safari 16.4+ (macOS and iOS) | Supported |
| Firefox 130+ | Supported for video; see the AAC note below |
| Older browsers | `compressVideo()` returns the original file with `skipReason: 'unsupported-browser'` |

Input formats are those Mediabunny can read (MP4, MOV, WebM, MKV and more) with a codec the browser can decode (H.264 everywhere; HEVC, VP9 and AV1 depending on the device).

### AAC encoding on Firefox and Linux

Some browsers ship WebCodecs without an AAC encoder. When the source audio is already AAC (most phone and camera recordings) it is copied and nothing else is needed. For other sources, register Mediabunny's WebAssembly AAC encoder once at startup:

```js
import { registerAacEncoder } from '@mediabunny/aac-encoder';
registerAacEncoder();
```

Without it, such files are returned unchanged with `skipReason: 'unsupported-browser'`.

## Notes

- **Memory and storage.** When the browser can write files to OPFS (detected at runtime; current Chrome, Edge and Firefox can) the output is written to disk and only the encoding pipeline uses memory. Elsewhere the output is held in memory, as reported by `storage: 'memory'`; on such browsers, for files beyond roughly 2 GB on mobile devices, consider passing the original through (`skipBelowMB`) or lowering `maxWidthOrHeight`. Private and incognito windows keep OPFS in memory, so there the output still uses memory. MP4 output written to disk keeps its index at the end of the file; players and servers that read with range requests handle this, and most upload pipelines transcode anyway.
- **Background tabs.** Browsers throttle background tabs, so compression slows down when the user switches away. Time spent hidden is not counted by the stall watchdog.
- **Web Workers.** The package uses only APIs available in workers, so it can run inside a dedicated worker if you prefer to keep the main thread free.
- **Privacy.** Files are processed on the user's device; nothing is sent anywhere by this package.

## Help with production rollouts

The VideoKit team runs in-browser video processing for a large public audience and helps teams bring it into their own upload flows: course platforms, form builders, recruiting tools and marketplaces. Tell us about your use case on the [documentation page](https://www.videokit.cc/en/browser-video-compression#contact).

## Contributing

Issues and pull requests are welcome. Please include the browser version and, where possible, a sample file for encoding problems.

```bash
npm install
npm run build
```

## License

[MIT](./LICENSE)
