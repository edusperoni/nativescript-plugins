# NativeScript Supabase Storage — Upstream Compatibility

This package is a fork of `@supabase/storage-js` with targeted overrides for NativeScript. The directory structure mirrors upstream (`lib/common/`, `packages/`) to simplify future syncs.

## What we change

### File uploads use native HTTP (`StorageFileApi`)

The `upload()`, `update()`, and `uploadToSignedUrl()` methods bypass the standard `fetch()`-based upload path. Instead, they use `@klippa/nativescript-http`:

- **`HTTPFormData` / `HTTPFormDataEntry`** replace the browser `FormData` API.
- **Platform-specific file handling:** when `fileBody` is a `string` (file path), it is resolved natively:
  - Android: `new java.io.File(fileBody)`
  - iOS: `NSData.dataWithContentsOfURL(NSURL.URLWithString(fileBody))`
- **`Http.request()`** is called directly instead of going through the shared `post()`/`put()` fetch helpers.

All other methods (download, list, move, copy, signed URLs, info, exists, bucket operations, vectors, analytics) use the standard `fetch()`-based code path unchanged.

### `resolveResponse` / `resolveFetch` (helpers)

- `resolveResponse` returns the global `Response` directly — the upstream `cross-fetch` dynamic import is removed since NativeScript provides `Response` globally.
- `resolveFetch` has `@ts-ignore` annotations on the spread calls to suppress a TypeScript tuple-type error that only appears under strict NativeScript tsconfig settings.

## What we do NOT change

Everything else is a 1:1 copy of upstream, including:

- `BaseApiClient` (handleOperation, throwOnError, setHeader)
- Error classes and namespace system (storage / vectors)
- Fetch helpers (get, post, put, head, remove, vectorsApi)
- Header normalization
- `StorageBucketApi` (with useNewHostname, ListBucketOptions, BucketType support)
- Non-upload `StorageFileApi` methods (download, info, exists, list, listV2, createSignedUrl, createSignedUrls, getPublicUrl, move, copy, remove)
- `BlobDownloadBuilder` / `StreamDownloadBuilder`
- `StorageAnalyticsClient` (Iceberg)
- `StorageVectorsClient` and all vector API classes
- All types

## Syncing with upstream

When updating from a new version of `@supabase/storage-js`:

1. Diff the upstream `src/` tree against our `lib/` + `packages/` tree.
2. Apply upstream changes to all files **except** the two upload methods in `packages/StorageFileApi.ts` and the two helpers noted above.
3. For the upload methods, merge any new options/fields (e.g. `metadata`, `headers`) into the NativeScript-specific code path while keeping the `Http.request()` / `HTTPFormData` machinery.
4. Run `npx nx run nativescript-supabase:build` to verify.
