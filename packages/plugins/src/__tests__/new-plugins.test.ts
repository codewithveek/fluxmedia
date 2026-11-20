import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import sharp from 'sharp';
import { MediaUploader, MemoryProvider, MediaErrorCode } from '@fluxmedia/core';
import {
  createVirusScanPlugin,
  createClamAVScanner,
  createDeduplicationPlugin,
  createPlaceholderPlugin,
  createImageOptimizationPlugin,
  createAnalyticsPlugin,
} from '../index';
import { Readable } from 'node:stream';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('virus scan plugin', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('rejects infected files and passes clean ones', async () => {
    const scan = vi.fn(async (data: Buffer) =>
      data.toString().includes('EICAR') ? { clean: false, threat: 'Eicar-Test' } : { clean: true }
    );
    const uploader = new MediaUploader(new MemoryProvider(), [createVirusScanPlugin({ scan })]);
    await expect(uploader.upload(Buffer.from('X5O!P%@AP EICAR'))).rejects.toThrow('Eicar-Test detected');
    await expect(uploader.upload(PNG)).resolves.toBeDefined();
  });

  it('fails closed when the scanner errors, and rejects streams by default', async () => {
    const plugin = createVirusScanPlugin({ scan: async () => Promise.reject(new Error('down')) });
    await expect(plugin.hooks.beforeUpload!(PNG, {})).rejects.toMatchObject({
      code: MediaErrorCode.PROVIDER_ERROR,
    });
    await expect(plugin.hooks.beforeUpload!(Readable.from([PNG]), {})).rejects.toThrow('Streams cannot be virus scanned');
  });

  it('speaks the clamd INSTREAM protocol', async () => {
    let received = Buffer.alloc(0);
    server = createServer((socket) => {
      socket.on('data', (d) => (received = Buffer.concat([received, d])));
      socket.on('end', () => {
        // Reassemble the length-prefixed chunks
        let offset = 'zINSTREAM\0'.length;
        const parts: Buffer[] = [];
        while (offset + 4 <= received.length) {
          const len = received.readUInt32BE(offset);
          offset += 4;
          if (len === 0) break;
          parts.push(received.subarray(offset, offset + len));
          offset += len;
        }
        const body = Buffer.concat(parts);
        socket.end(body.includes(Buffer.from('EICAR')) ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const scanner = createClamAVScanner({ port, chunkSize: 4 });

    expect(await scanner(Buffer.from('hello world'), { fileName: 'a', contentType: undefined })).toEqual({ clean: true });
    expect(received.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(received.subarray(10, 14).readUInt32BE(0)).toBe(4);
    expect(received.subarray(-4).readUInt32BE(0)).toBe(0);

    received = Buffer.alloc(0);
    expect(await scanner(Buffer.from('EICAR'), { fileName: 'a', contentType: undefined })).toEqual({
      clean: false,
      threat: 'Eicar-Signature',
    });
  });
});

describe('deduplication plugin', () => {
  it('returns the existing result for identical content in the same folder only', async () => {
    const provider = new MemoryProvider();
    const upload = vi.spyOn(provider, 'upload');
    const uploader = new MediaUploader(provider, [createDeduplicationPlugin()]);

    const a = await uploader.upload(PNG, { folder: 'users/1' });
    const b = await uploader.upload(PNG, { folder: 'users/1' });
    const c = await uploader.upload(PNG, { folder: 'users/2' });

    expect(b.id).toBe(a.id);
    expect(b.metadata.deduplicated).toBe(true);
    expect(c.id).not.toBe(a.id);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('respects an exact filename request', async () => {
    const uploader = new MediaUploader(new MemoryProvider(), [createDeduplicationPlugin()]);
    const a = await uploader.upload(PNG, { filename: 'a', uniqueFilename: false });
    const b = await uploader.upload(PNG, { filename: 'b', uniqueFilename: false });
    const again = await uploader.upload(PNG, { filename: 'a', uniqueFilename: false });
    expect([a.id, b.id, again.id]).toEqual(['a', 'b', 'a']);
    expect(again.metadata.deduplicated).toBe(true);
  });

  it('forgets deleted files', async () => {
    const uploader = new MediaUploader(new MemoryProvider(), [createDeduplicationPlugin()]);
    const a = await uploader.upload(PNG);
    await uploader.delete(a.id);
    const b = await uploader.upload(PNG);
    expect(b.metadata.deduplicated).toBeUndefined();
  });
});

describe('placeholder plugin', () => {
  it('adds a blurred data URI and dominant color', async () => {
    const red = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer();
    const uploader = new MediaUploader(new MemoryProvider(), [createPlaceholderPlugin()]);
    const result = await uploader.upload(red);
    const placeholder = result.metadata.placeholder as { dataUri: string; dominantColor: string; width: number };
    expect(placeholder.dataUri).toMatch(/^data:image\/webp;base64,/);
    expect(placeholder.width).toBe(16);
    expect(placeholder.dominantColor).toMatch(/^#f/);
    expect(result.metadata).not.toHaveProperty('_placeholder');
  });
});

describe('image optimization plugin', () => {
  it('strips EXIF from buffers and updates the content type', async () => {
    const withExif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#00ff00' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Make: 'SecretCam' } } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const plugin = createImageOptimizationPlugin({ format: 'webp' });
    const out = await plugin.hooks.beforeUpload!(withExif, {});
    expect(out!.options.contentType).toBe('image/webp');
    expect((await sharp(out!.file as Buffer).metadata()).exif).toBeUndefined();
  });

  it('keeps EXIF when stripMetadata is false', async () => {
    const withExif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#00ff00' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Make: 'SecretCam' } } })
      .toBuffer();
    const plugin = createImageOptimizationPlugin({ format: 'jpeg', stripMetadata: false, skipIfLarger: false });
    const out = await plugin.hooks.beforeUpload!(withExif, {});
    expect((await sharp(out!.file as Buffer).metadata()).exif).toBeDefined();
  });

  it('leaves streams untouched', async () => {
    const stream = Readable.from([PNG]);
    const out = await createImageOptimizationPlugin().hooks.beforeUpload!(stream, {});
    expect(out!.file).toBe(stream);
  });
});

describe('analytics plugin with the uploader', () => {
  it('measures duration via context and never stores the file in metadata', async () => {
    const track = vi.fn();
    const uploader = new MediaUploader(new MemoryProvider(), [
      createAnalyticsPlugin({ track, console: false }),
    ]);
    const result = await uploader.upload(Readable.from([PNG]), { contentType: 'image/png' });
    expect(track).toHaveBeenCalledWith('media.upload.started', expect.objectContaining({ fileSize: undefined }));
    expect(result.metadata).not.toHaveProperty('_analyticsFile');
    expect(result.metadata).not.toHaveProperty('_analyticsUploadId');
    expect(result.metadata.performance).toBeDefined();
  });
});
