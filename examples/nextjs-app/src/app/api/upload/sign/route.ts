import { createSignedUploadHandler } from '@fluxmedia/core/server';
import { getUploader, getUser, parseProvider, UPLOAD_RULES } from '@/lib/uploaders';

/**
 * Signed uploads: returns a short-lived target the browser uploads to
 * directly. On S3 and R2 the content type and exact size are part of the
 * signature, so storage rejects any other file.
 */
export async function POST(request: Request) {
  const provider = parseProvider(new URL(request.url).searchParams.get('provider') ?? 'cloudinary');
  if (!provider) return Response.json({ error: 'Unknown provider' }, { status: 400 });

  const handler = createSignedUploadHandler(await getUploader(provider), {
    ...UPLOAD_RULES,
    authorize: getUser,
    folder: (user) => `uploads/${user.id}`,
    expiresIn: 300,
    onError: (error) => console.error('Sign error:', error),
  });
  return handler(request);
}
