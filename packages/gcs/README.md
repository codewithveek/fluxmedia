# @fluxmedia/gcs

Google Cloud Storage provider for [FluxMedia](https://www.fluxmedia.dev).

```bash
pnpm add @fluxmedia/core @fluxmedia/gcs @google-cloud/storage
```

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { GCSProvider } from '@fluxmedia/gcs';

const uploader = new MediaUploader(
  new GCSProvider({
    bucket: 'my-bucket',
    // Without credentials, Application Default Credentials are used
    // (Workload Identity, Cloud Run / GCE service accounts, gcloud auth).
    publicUrl: false, // private bucket: serve with getSignedUrl()
  })
);

const result = await uploader.upload(file, { folder: 'docs' });
const url = await uploader.getSignedUrl(result, { expiresIn: 600 });
```

- Streams, and files above 8 MB, use resumable uploads, with byte progress and cancel (`signal`).
- `getSignedUrl()` and `createUploadUrl()` use V4 signing (max 7 days). Upload URLs sign the content type and, with `size`, cap the upload with `x-goog-content-length-range`.
- Supports `list` (page tokens), `copy`, `move`, `download`, `updateMetadata` and `exists`.

**Signing credentials.** Signed URLs need a credential that can sign: a service account key, or — on Cloud Run, GKE or GCE with Application Default Credentials — the service account needs the `iam.serviceAccounts.signBlob` permission (role "Service Account Token Creator" on itself), because signing then goes through the IAM API.

## Configuration

| Option               | Type            | Description                                                         |
| -------------------- | --------------- | ------------------------------------------------------------------- |
| `bucket`             | string          | Bucket name (required)                                              |
| `projectId`          | string          | Project ID                                                          |
| `keyFilename`        | string          | Service account key file                                            |
| `credentials`        | object          | Service account credentials                                         |
| `storage`            | Storage         | Existing client                                                     |
| `publicUrl`          | string \| false | CDN/base URL, `false` for private, unset for `storage.googleapis.com` |
| `useAcl`             | boolean         | Apply `public` as an object ACL (fine-grained buckets only)         |
| `appendExtension`    | boolean         | Append the detected extension to keys                               |
| `resumableThreshold` | number          | Size above which uploads are resumable (default 8 MB)               |

Browser uploads need a bucket CORS rule allowing `PUT` with the `Content-Type` and `x-goog-*` headers.
