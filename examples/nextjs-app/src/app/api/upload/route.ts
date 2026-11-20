import { createProxyUploadHandler } from '@fluxmedia/core/server';
import { getUploader, getUser, parseProvider, UPLOAD_RULES } from '@/lib/uploaders';

/**
 * Proxy uploads: the file goes through this server, so plugins (retry,
 * logging, …) run. The handler authenticates, enforces size before reading
 * the body, detects the type from the file's bytes, and stores it under a
 * folder chosen here — never one sent by the client.
 */
export async function POST(request: Request) {
  const provider = parseProvider(new URL(request.url).searchParams.get('provider') ?? 'r2');
  if (!provider) return Response.json({ error: 'Unknown provider' }, { status: 400 });

  const handler = createProxyUploadHandler(await getUploader(provider), {
    ...UPLOAD_RULES,
    authorize: getUser,
    folder: (user) => `uploads/${user.id}`,
    onError: (error) => console.error('Upload error:', error),
  });
  return handler(request);
}
