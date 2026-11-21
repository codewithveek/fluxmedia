# @fluxmedia/plugins

## 3.0.0

### Major Changes

- Security fixes, bug fixes, signed URLs, server upload handlers and new providers.

  **Breaking changes**
  - `UploadResult.publicUrl` is optional. It is omitted for private storage (R2 without `publicUrl`, S3/GCS/Azure with `publicUrl: false`, Cloudinary `public: false` uploads).
  - Folders and filenames are sanitized: `..` segments, leading slashes, backslashes and characters outside letters, digits, `.`, `_` and `-` are removed or replaced. Keys containing spaces or other symbols are generated differently.
  - Only top-level string/number/boolean metadata is written to storage. Keys starting with `_` and nested objects stay in-process.
  - `MediaUploader.uploadMultiple` uploads with a concurrency of 3 and, when any upload fails, throws a `MediaError` whose `details` hold the `succeeded` results and `failed` indexes.
  - `MediaUploader.deleteMultiple` uses the provider's batch delete for plain IDs.
  - `search` and other unsupported operations throw `MediaError` with the new `NOT_SUPPORTED` code.
  - The validation plugin detects types from file content by default (`useMagicBytes: true`), compares extensions case-insensitively, and `image/*` no longer matches SVG.
  - The retry plugin retries uploads itself through the new `wrapUpload` hook and no longer writes `_retry` metadata; `getRetryConfig` is deprecated.
  - `R2Provider` extends `S3Provider` (new dependency on `@fluxmedia/s3`).
  - Cloudinary uploads put the folder in the public ID instead of the `folder` parameter, and `get()` uses the Admin API instead of `explicit()`.
  - React: the signed-mode request includes `size`, and `mode: 'direct'` rejects with an explanation.

  **Security**
  - New `@fluxmedia/core/server` handlers (`createSignedUploadHandler`, `createProxyUploadHandler`) that require authorization, an allowed-type list and a size limit, decide the folder on the server, and detect types from file content.
  - S3/R2 presigned uploads sign the content type and exact content length; GCS upload URLs cap the size.
  - `public` is honoured (Cloudinary `authenticated`, S3 ACLs with `useAcl`) or rejected when a bucket cannot honour it.
  - Cloudinary credentials are passed per request, so providers for different accounts no longer overwrite each other.
  - The image optimization plugin now actually strips EXIF/GPS (it previously kept it); metadata extraction only includes GPS with `includeGps`.
  - The analytics plugin no longer stores the whole file in upload metadata.
  - Example routes require authentication and use the new handlers.

  **Fixes**
  - `signal` cancels S3/R2/GCS/Azure/local/Cloudinary uploads (new `ABORTED` code).
  - Streams are never retried or sent to a fallback provider; files stored by the fallback are deleted/read from it when you pass the `UploadResult`.
  - `beforeUpload` failures reach `onError`; a failing `onError` hook no longer masks the original error; constructor plugins are awaited.
  - Cloudinary: deleting videos/raw files works, File inputs upload, buffers stream instead of being base64-encoded, source-stream errors reject instead of hanging, real byte progress, rate limits map to `RATE_LIMITED`.
  - S3/R2: stream sizes are reported, `get()` no longer reports every failure as `FILE_NOT_FOUND`, keys are URL-encoded, failed multipart uploads are cleaned up.
  - Validation/metadata/optimization plugins no longer consume streams, and handle Buffers.
  - React: type detection works in browsers without a `Buffer` polyfill.

  **Features**
  - `getSignedUrl`, `createUploadUrl`, `exists`, `list`/`listAll`, `copy`, `move`, `download`, `updateMetadata` on `MediaUploader` and providers.
  - S3: default AWS credential chain, session tokens, custom clients, CloudFront `publicUrl`, `appendExtension`, `providerOptions`, `cacheControl`/`contentDisposition`, tags.
  - R2: jurisdictions and `R2BindingProvider` for Workers bucket bindings.
  - Cloudinary: token-auth signed URLs, signed browser uploads, Search API list/search.
  - New providers: `@fluxmedia/gcs`, `@fluxmedia/azure`, `@fluxmedia/local`, and `MemoryProvider` in core.
  - New plugins: virus scanning (with a ClamAV client), deduplication, placeholders; full EXIF via `exif-reader`.
  - React: `cancel()`, `accept`/`maxSize` checks, auth `headers`, server error messages, `useMediaUploadQueue`, drag-and-drop in `<MediaUpload>`.
  - HMAC signed URLs (`createSignedUrl`/`verifySignedUrl`) for providers without native signing.

### Patch Changes

- Updated dependencies
  - @fluxmedia/core@3.0.0

## 2.0.1

### Patch Changes

- Extract shared plugin utilities into a common `utils` module; fix `File` (Web API) input handling in validation, metadata, and optimization plugins.
- Updated dependencies
  - @fluxmedia/core@2.0.1

## 1.0.1

### Patch Changes

- Update descriptions, READMEs, and documentation to reflect the new "One API" messaging strategy.
- Updated dependencies
  - @fluxmedia/core@1.0.1

## 0.1.1

### Patch Changes

- Package size optimizations: externalized vitest from testing module, disabled source maps, removed tsdown dependency. Added typed analytics events, updated repository URL.
- Updated dependencies
  - @fluxmedia/core@0.1.1

## 0.1.0

### Minor Changes

- Add plugins package with file validation, image optimization, metadata extraction, analytics, and retry plugins. Centralize file type detection utility in core package using magic bytes.

### Patch Changes

- Updated dependencies
  - @fluxmedia/core@0.1.0
