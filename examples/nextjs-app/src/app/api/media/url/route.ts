import { MediaError, MediaErrorCode } from '@fluxmedia/core';
import { getUploader, getUser, parseProvider } from '@/lib/uploaders';

/**
 * Short-lived read URL for a private file. Users may only read files in
 * their own folder.
 */
export async function GET(request: Request) {
  const user = getUser(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const provider = parseProvider(params.get('provider'));
  const key = params.get('key') ?? '';
  if (!provider || !key.startsWith(`uploads/${user.id}/`)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const uploader = await getUploader(provider);
    const url = await uploader.getSignedUrl(key, { expiresIn: 300 });
    return Response.json({ url, expiresIn: 300 }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof MediaError && error.code === MediaErrorCode.INVALID_CONFIG) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('Signed URL error:', error);
    return Response.json({ error: 'Could not create URL' }, { status: 500 });
  }
}
