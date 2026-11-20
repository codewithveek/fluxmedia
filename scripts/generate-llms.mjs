// Regenerate llms.txt and llms-full.txt for both docs sites from the docs pages.
// Run with: pnpm docs:llms
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 'https://www.fluxmedia.dev/docs';
const DOCS = 'webapp/content/docs';

// Same order as the sidebar (webapp/lib/docs.ts)
const pages = [
  { slug: 'getting-started', title: 'Getting Started', summary: 'Installation, basic usage, streaming uploads, browser uploads, fallback providers, abort, progress, private files' },
  { slug: 'providers', title: 'Providers', summary: 'Provider comparison, choosing a provider, writing a custom provider' },
  { slug: 'cloudinary', title: 'Cloudinary Provider', summary: 'Transformations, private assets, signed URLs and uploads, search', provider: true },
  { slug: 's3', title: 'AWS S3 Provider', summary: 'Credentials chain, private buckets, presigned URLs, CloudFront, S3-compatible services, file operations', provider: true },
  { slug: 'r2', title: 'Cloudflare R2 Provider', summary: 'Public or private buckets, presigned URLs, Workers bucket bindings', provider: true },
  { slug: 'gcs', title: 'Google Cloud Storage Provider', summary: 'Application Default Credentials, V4 signed URLs, resumable uploads', provider: true },
  { slug: 'azure', title: 'Azure Blob Storage Provider', summary: 'Shared key or Entra ID, SAS URLs, block blob streaming', provider: true },
  { slug: 'local', title: 'Local Filesystem Provider', summary: 'Atomic writes, signed URLs, safe file-serving handler', provider: true },
  { slug: 'secure-uploads', title: 'Secure Uploads', summary: 'Signed and proxy upload handlers, allowed types, private files, ownership checks, checklist' },
  { slug: 'plugins', title: 'Plugins', summary: 'Validation, optimization, metadata, virus scanning, dedupe, placeholders, analytics, retry, custom plugins' },
  { slug: 'react', title: 'React Integration', summary: 'useMediaUpload, useMediaUploadQueue, MediaUpload drag-and-drop, cancel, client-side checks' },
  { slug: 'api', title: 'API Reference', summary: 'MediaUploader methods, types, MediaProvider interface, errors, plugin hooks, testing utilities' },
];

const intro = `> FluxMedia is a unified media upload library for JavaScript and TypeScript. It provides one API for uploading images, videos, and files to Cloudinary, AWS S3 (and S3-compatible storage), Cloudflare R2, Google Cloud Storage, Azure Blob Storage, or the local filesystem. Write your upload logic once, and it works with every provider.

FluxMedia is an open-source library — not a storage service. It wraps existing providers behind the \`MediaProvider\` interface, published as npm packages under the \`@fluxmedia\` scope.

- One API on every provider: \`upload\`, \`get\`, \`delete\`, \`getUrl\`, \`getSignedUrl\`, \`createUploadUrl\`, \`exists\`, \`list\`/\`listAll\`, \`copy\`, \`move\`, \`download\`, \`updateMetadata\`, \`uploadMultiple\`, \`deleteMultiple\`, \`uploadWithTransaction\`
- Secure browser uploads: \`createSignedUploadHandler\` and \`createProxyUploadHandler\` from \`@fluxmedia/core/server\` require authorization, an allowed-type list and a size limit, decide the folder on the server, and detect file types from content
- Private files: public URLs are optional; time-limited signed URLs on every provider (S3/R2 presigned, GCS V4, Azure SAS, Cloudinary private download or token auth, HMAC for local/R2 bindings)
- Accepts \`File\`, \`Buffer\`, Node \`Readable\` and web \`ReadableStream\`; byte progress; cancel with \`AbortSignal\`
- Fallback providers, transactional uploads, retry with backoff
- Plugins via lifecycle hooks: \`beforeUpload\`, \`wrapUpload\`, \`afterUpload\`, \`onError\`, \`beforeDelete\`, \`afterDelete\`, \`beforeGetUrl\`
- Structured errors with the \`MediaErrorCode\` enum (including \`ABORTED\`, \`NOT_SUPPORTED\`, \`RATE_LIMITED\`)
- React integration: \`useMediaUpload\`, \`useMediaUploadQueue\`, \`MediaUpload\`
- Only top-level primitive metadata is stored with files; keys and folders are sanitized`;

const packages = [
  ['@fluxmedia/core', 'MediaUploader, plugin system, server upload handlers (`@fluxmedia/core/server`), MemoryProvider, signed-URL helpers, structured errors, file type detection, testing utilities (`@fluxmedia/core/testing`)'],
  ['@fluxmedia/cloudinary', 'Cloudinary provider with transformations'],
  ['@fluxmedia/s3', 'AWS S3 and S3-compatible storage (MinIO, Backblaze B2, Wasabi, DigitalOcean Spaces, Supabase Storage)'],
  ['@fluxmedia/r2', 'Cloudflare R2 provider (S3 API) and R2BindingProvider for Workers'],
  ['@fluxmedia/gcs', 'Google Cloud Storage provider'],
  ['@fluxmedia/azure', 'Azure Blob Storage provider'],
  ['@fluxmedia/local', 'Local filesystem provider and file-serving handler'],
  ['@fluxmedia/react', 'React hooks and components'],
  ['@fluxmedia/plugins', 'Official plugins: validation, image optimization, metadata extraction, virus scanning, deduplication, placeholders, analytics, retry'],
];

const link = (page) => `${SITE}/${page.slug}`;

const llms = `# FluxMedia Documentation

${intro}

## Docs

${pages.filter((p) => !p.provider).map((p) => `- [${p.title}](${link(p)}): ${p.summary}`).join('\n')}

## Providers

${pages.filter((p) => p.provider).map((p) => `- [${p.title}](${link(p)}): ${p.summary}`).join('\n')}

## Packages

${packages.map(([name, desc]) => `- \`${name}\`: ${desc}`).join('\n')}

## Optional

- [Full documentation in one file](https://www.fluxmedia.dev/llms-full.txt)
- [Source Code](https://github.com/codewithveek/fluxmedia): GitHub repository with full source, examples, and issue tracker
`;

/** Demote every Markdown heading one level, skipping fenced code blocks. */
function demote(markdown) {
  let inFence = false;
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      return !inFence && /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join('\n')
    .trim();
}

const full = `# FluxMedia Documentation

${intro}

## Packages

| Package | Description |
|---------|-------------|
${packages.map(([name, desc]) => `| \`${name}\` | ${desc} |`).join('\n')}

${pages
  .map((p) => `---\n\n<!-- Source: ${link(p)} -->\n\n${demote(readFileSync(join(DOCS, `${p.slug}.mdx`), 'utf8'))}`)
  .join('\n\n')}
`;

for (const dir of ['webapp/public', 'docs/public']) {
  writeFileSync(join(dir, 'llms.txt'), llms);
  writeFileSync(join(dir, 'llms-full.txt'), full);
  console.log(`wrote ${dir}/llms.txt and ${dir}/llms-full.txt`);
}
