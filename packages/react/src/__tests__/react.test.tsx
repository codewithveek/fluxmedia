// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { useMediaUpload } from '../use-media-upload';
import { useMediaUploadQueue } from '../use-media-upload-queue';
import { MediaUpload } from '../media-upload';
import { UploadClientError, validateFile } from '../upload-client';

type XhrBehavior = { status: number; response: string; hang?: boolean };

const requests: Array<{
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}> = [];
let xhrBehavior: XhrBehavior = { status: 200, response: '' };

class FakeXHR {
  upload = new EventTarget();
  private listeners = new EventTarget();
  status = 0;
  responseText = '';
  withCredentials = false;
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};
  addEventListener(type: string, fn: EventListener) {
    this.listeners.addEventListener(type, fn);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send(body: unknown) {
    requests.push({ method: this.method, url: this.url, headers: this.headers, body });
    if (xhrBehavior.hang) return;
    setTimeout(() => {
      const progress = Object.assign(new Event('progress'), { lengthComputable: true, loaded: 5, total: 10 });
      this.upload.dispatchEvent(progress);
      this.status = xhrBehavior.status;
      this.responseText = xhrBehavior.response;
      this.listeners.dispatchEvent(new Event('load'));
    }, 0);
  }
  abort() {
    this.listeners.dispatchEvent(new Event('abort'));
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  requests.length = 0;
  xhrBehavior = { status: 200, response: '' };
  fetchMock.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cat.png', { type: 'image/png' });

function signResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('validateFile', () => {
  it('checks accept patterns, extensions and size', () => {
    expect(validateFile(png(), { accept: 'image/*' })).toBeNull();
    expect(validateFile(png(), { accept: ['.png'] })).toBeNull();
    expect(validateFile(png(), { accept: 'application/pdf' })).toMatch(/not an accepted/);
    expect(validateFile(png(), { maxSize: 1 })).toMatch(/exceeds/);
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' });
    expect(validateFile(svg, { accept: 'image/*' })).toMatch(/not an accepted/);
  });
});

describe('useMediaUpload signed mode', () => {
  it('sends size and content type, then PUTs with the signed headers', async () => {
    fetchMock.mockResolvedValue(
      signResponse({
        uploadUrl: 'https://bucket.s3/key?X-Amz-Signature=1',
        method: 'PUT',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
        storageKey: 'users/1/cat-x',
        provider: 's3',
        expiresAt: new Date().toISOString(),
      })
    );
    const { result } = renderHook(() =>
      useMediaUpload({ mode: 'signed', signUrlEndpoint: '/sign', headers: { authorization: 'Bearer t' } })
    );

    let uploadResult: Awaited<ReturnType<typeof result.current.upload>> | undefined;
    await act(async () => {
      uploadResult = await result.current.upload(png());
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toMatchObject({ filename: 'cat.png', contentType: 'image/png', size: 4 });
    expect(init.headers).toMatchObject({ authorization: 'Bearer t' });
    expect(requests[0]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } });
    expect(requests[0]!.headers).not.toHaveProperty('Content-Length');
    expect(uploadResult).toMatchObject({ id: 'users/1/cat-x', provider: 's3', url: 'https://bucket.s3/key' });
    expect(uploadResult).not.toHaveProperty('publicUrl');
    expect(result.current.progress).toBe(100);
  });

  it('surfaces the server error message', async () => {
    fetchMock.mockResolvedValue(signResponse({ error: 'File type text/html is not allowed' }, 415));
    const { result } = renderHook(() => useMediaUpload({ mode: 'signed', signUrlEndpoint: '/sign' }));
    await act(async () => {
      await expect(result.current.upload(png())).rejects.toThrow('File type text/html is not allowed');
    });
    expect(result.current.error).toBeInstanceOf(UploadClientError);
  });

  it('posts Cloudinary form fields and reads the response', async () => {
    fetchMock.mockResolvedValue(
      signResponse({
        uploadUrl: 'https://api.cloudinary.com/v1_1/demo/image/upload',
        method: 'POST',
        fields: { signature: 'sig', api_key: 'k', public_id: 'a' },
        storageKey: 'a',
        provider: 'cloudinary',
      })
    );
    xhrBehavior = {
      status: 200,
      response: JSON.stringify({ public_id: 'a', secure_url: 'https://res/a.png', type: 'upload', bytes: 4, format: 'png' }),
    };
    const { result } = renderHook(() => useMediaUpload({ mode: 'signed', signUrlEndpoint: '/sign' }));
    let out: { publicUrl?: string; url: string } | undefined;
    await act(async () => {
      out = await result.current.upload(png());
    });
    expect((requests[0]!.body as FormData).get('signature')).toBe('sig');
    expect(out).toMatchObject({ url: 'https://res/a.png', publicUrl: 'https://res/a.png' });
  });

  it('cancels an upload', async () => {
    fetchMock.mockResolvedValue(signResponse({ uploadUrl: 'https://x', method: 'PUT', storageKey: 'k' }));
    xhrBehavior = { status: 200, response: '', hang: true };
    const { result } = renderHook(() => useMediaUpload({ mode: 'signed', signUrlEndpoint: '/sign' }));
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.upload(png());
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => result.current.cancel());
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('lets concurrent uploads all complete (a new upload does not cancel the previous one)', async () => {
    fetchMock.mockImplementation(async () =>
      signResponse({ uploadUrl: 'https://x/k', method: 'PUT', storageKey: 'k' })
    );
    const { result } = renderHook(() => useMediaUpload({ mode: 'signed', signUrlEndpoint: '/sign' }));
    let outcomes: PromiseSettledResult<unknown>[] = [];
    await act(async () => {
      outcomes = await Promise.allSettled([result.current.upload(png()), result.current.upload(png())]);
    });
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(result.current.uploading).toBe(false);
  });

  it('rejects files that fail client-side validation without calling the server', async () => {
    const { result } = renderHook(() =>
      useMediaUpload({ mode: 'signed', signUrlEndpoint: '/sign', maxSize: 1 })
    );
    await act(async () => {
      await expect(result.current.upload(png())).rejects.toMatchObject({ kind: 'validation' });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses direct mode with a clear message', async () => {
    const { result } = renderHook(() => useMediaUpload({ mode: 'direct' }));
    await act(async () => {
      await expect(result.current.upload(png())).rejects.toThrow(/expose storage credentials/);
    });
  });

  it('detects file types in the browser without Buffer', async () => {
    const { result } = renderHook(() => useMediaUpload({ mode: 'proxy', proxyEndpoint: '/u' }));
    const bytes = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0)
    );
    let detected: unknown;
    await act(async () => {
      detected = await result.current.detectFileType(new File([bytes], 'x.bin'));
    });
    expect(detected).toEqual({ mime: 'image/png', ext: 'png' });
  });
});

describe('useMediaUpload proxy mode', () => {
  it('posts multipart data and validates the response shape', async () => {
    xhrBehavior = {
      status: 200,
      response: JSON.stringify({ id: 'k', url: 'https://cdn/k', provider: 'r2', storageKey: 'k' }),
    };
    const { result } = renderHook(() => useMediaUpload({ mode: 'proxy', proxyEndpoint: '/upload' }));
    let out: unknown;
    await act(async () => {
      out = await result.current.upload(png(), { folder: 'x' });
    });
    expect((requests[0]!.body as FormData).get('folder')).toBe('x');
    expect(out).toMatchObject({ id: 'k', url: 'https://cdn/k', storageKey: 'k' });
    expect(out).not.toHaveProperty('publicUrl');
  });
});

describe('useMediaUploadQueue', () => {
  it('uploads with per-file status, marks invalid files and supports retry', async () => {
    xhrBehavior = { status: 500, response: JSON.stringify({ error: 'boom' }) };
    const onQueueComplete = vi.fn();
    const { result } = renderHook(() =>
      useMediaUploadQueue({ mode: 'proxy', proxyEndpoint: '/u', accept: 'image/*' }, { onQueueComplete })
    );
    const pdf = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' });

    act(() => result.current.add([png(), pdf]));
    expect(result.current.items[1]!.status).toBe('error');

    await waitFor(() => expect(result.current.items[0]!.status).toBe('error'));
    expect(result.current.items[0]!.error?.message).toBe('boom');
    expect(onQueueComplete).toHaveBeenCalled();

    xhrBehavior = { status: 200, response: JSON.stringify({ id: 'k', url: 'https://cdn/k' }) };
    act(() => result.current.retry(result.current.items[0]!.id));
    await waitFor(() => expect(result.current.items[0]!.status).toBe('done'));
    expect(result.current.items[0]!.result?.id).toBe('k');
  });

  it('respects concurrency and cancels pending items', async () => {
    xhrBehavior = { status: 200, response: '', hang: true };
    const { result } = renderHook(() =>
      useMediaUploadQueue({ mode: 'proxy', proxyEndpoint: '/u' }, { concurrency: 1 })
    );
    act(() => result.current.add([png(), png()]));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(result.current.items.map((i) => i.status)).toEqual(['uploading', 'pending']);

    act(() => result.current.cancel(result.current.items[1]!.id));
    expect(result.current.items[1]!.status).toBe('cancelled');
    act(() => result.current.cancel(result.current.items[0]!.id));
    await waitFor(() => expect(result.current.items[0]!.status).toBe('cancelled'));
  });
});

describe('MediaUpload', () => {
  it('uploads dropped files and exposes drag state', async () => {
    xhrBehavior = { status: 200, response: JSON.stringify({ id: 'k', url: 'https://cdn/k' }) };
    const onComplete = vi.fn();
    const { getByTestId } = render(
      <MediaUpload config={{ mode: 'proxy', proxyEndpoint: '/u' }} onComplete={onComplete}>
        {({ getRootProps, isDragging }) => (
          <div data-testid="drop" data-dragging={isDragging} {...getRootProps()} />
        )}
      </MediaUpload>
    );
    const drop = getByTestId('drop');
    fireEvent.dragEnter(drop);
    expect(drop.getAttribute('data-dragging')).toBe('true');
    fireEvent.drop(drop, { dataTransfer: { files: [png()] } });
    expect(drop.getAttribute('data-dragging')).toBe('false');
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith([expect.objectContaining({ id: 'k' })]));
  });

  it('rejects files that do not match accept', async () => {
    const onError = vi.fn();
    const { getByTestId } = render(
      <MediaUpload config={{ mode: 'proxy', proxyEndpoint: '/u' }} accept="application/pdf" onError={onError} />
    );
    fireEvent.change(getByTestId('fluxmedia-file-input'), { target: { files: [png()] } });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(requests).toHaveLength(0);
  });
});
