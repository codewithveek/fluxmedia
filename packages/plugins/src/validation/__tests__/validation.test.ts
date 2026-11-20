import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createFileValidationPlugin } from '../index';
import { MediaError, MediaErrorCode } from '@fluxmedia/core';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// Minimal JPEG header (SOI + APP0 JFIF)
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(64),
]);
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

function file(bytes: Buffer, name: string, type: string, size?: number): File {
  const f = new File([new Uint8Array(bytes)], name, { type });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return f;
}

const run = (plugin: ReturnType<typeof createFileValidationPlugin>, input: unknown, opts = {}) =>
  plugin.hooks.beforeUpload!(input as File, opts);

describe('FileValidationPlugin', () => {
  describe('file size validation', () => {
    it('allows files within size limits and records validation metadata', async () => {
      const plugin = createFileValidationPlugin({ maxSize: 5 * 1024 * 1024, minSize: 10 });
      const f = file(PNG, 'test.png', 'image/png');
      const result = await run(plugin, f);
      expect(result!.file).toBe(f);
      expect(result!.options.metadata?.validation).toMatchObject({
        validated: true,
        fileSize: PNG.byteLength,
        fileType: 'image/png',
      });
    });

    it('rejects files exceeding max size', async () => {
      const plugin = createFileValidationPlugin({ maxSize: 1024 });
      await expect(run(plugin, file(PNG, 'a.png', 'image/png', 4096))).rejects.toMatchObject({
        code: MediaErrorCode.FILE_TOO_LARGE,
      });
    });

    it('rejects files below min size', async () => {
      const plugin = createFileValidationPlugin({ minSize: 1024 });
      await expect(run(plugin, file(PNG, 'a.png', 'image/png'))).rejects.toThrow('below minimum');
    });

    it('enforces maxSize on streams while they are read', async () => {
      const plugin = createFileValidationPlugin({ maxSize: 10 });
      const result = await run(plugin, Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), {
        contentType: 'application/octet-stream',
      });
      const chunks: Buffer[] = [];
      await expect(
        (async () => {
          for await (const c of result!.file as Readable) chunks.push(c);
        })()
      ).rejects.toMatchObject({ code: MediaErrorCode.FILE_TOO_LARGE });
    });
  });

  describe('file type validation', () => {
    it('detects the type from content, not the declared type', async () => {
      const plugin = createFileValidationPlugin({ allowedTypes: ['image/*'] });
      // HTML declared as PNG must be rejected
      await expect(run(plugin, file(Buffer.from('<html><script>'), 'x.png', 'image/png'))).rejects.toThrow(
        'not allowed'
      );
      // A real PNG declared as text passes as PNG
      const result = await run(plugin, file(PNG, 'x.txt', 'text/plain'));
      expect(result!.options.contentType).toBe('image/png');
    });

    it('allows specific MIME types', async () => {
      const plugin = createFileValidationPlugin({ allowedTypes: ['image/jpeg', 'image/png'] });
      await expect(run(plugin, file(JPEG, 'a.jpg', 'image/jpeg'))).resolves.toBeDefined();
      await expect(run(plugin, PNG)).resolves.toBeDefined();
    });

    it('rejects disallowed MIME types', async () => {
      const plugin = createFileValidationPlugin({ allowedTypes: ['image/*'] });
      await expect(run(plugin, file(PDF, 'doc.pdf', 'application/pdf'))).rejects.toThrow('not allowed');
    });

    it('does not let image/* admit SVG', async () => {
      const svg = file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'a.svg', 'image/svg+xml');
      await expect(run(createFileValidationPlugin({ allowedTypes: ['image/*'] }), svg)).rejects.toThrow('not allowed');
      await expect(
        run(createFileValidationPlugin({ allowedTypes: ['image/svg+xml'] }), svg)
      ).resolves.toBeDefined();
    });

    it('accepts text formats without a magic-byte signature', async () => {
      const plugin = createFileValidationPlugin({ allowedTypes: ['text/csv'] });
      await expect(run(plugin, file(Buffer.from('a,b\n1,2'), 'a.csv', 'text/csv'))).resolves.toBeDefined();
    });

    it('requires a declared contentType for streams when types are restricted', async () => {
      const plugin = createFileValidationPlugin({ allowedTypes: ['image/png'] });
      await expect(run(plugin, Readable.from([PNG]))).rejects.toThrow('set contentType for streams');
      await expect(run(plugin, Readable.from([PNG]), { contentType: 'image/png' })).resolves.toBeDefined();
    });

    it('can trust declared types when useMagicBytes is false', async () => {
      const plugin = createFileValidationPlugin({ allowedTypes: ['image/png'], useMagicBytes: false });
      await expect(run(plugin, file(Buffer.from('x'), 'a.png', 'image/png'))).resolves.toBeDefined();
    });
  });

  describe('extension validation', () => {
    it('rejects blocked extensions case-insensitively', async () => {
      const plugin = createFileValidationPlugin({ blockedExtensions: ['.exe', 'bat'] });
      await expect(run(plugin, file(Buffer.from('MZ'), 'virus.EXE', 'application/octet-stream'))).rejects.toThrow(
        'blocked'
      );
      await expect(run(plugin, file(Buffer.from('x'), 'run.Bat', 'application/octet-stream'))).rejects.toThrow(
        'blocked'
      );
    });

    it('also checks the extension of the detected type', async () => {
      const plugin = createFileValidationPlugin({ blockedExtensions: ['.pdf'] });
      await expect(run(plugin, file(PDF, 'innocent.txt', 'text/plain'))).rejects.toThrow('blocked');
    });

    it('allows only specified extensions', async () => {
      const plugin = createFileValidationPlugin({ allowedExtensions: ['.jpg', '.png', '.gif'] });
      await expect(run(plugin, file(JPEG, 'image.JPG', 'image/jpeg'))).resolves.toBeDefined();
      await expect(run(plugin, file(PDF, 'doc.pdf', 'application/pdf'))).rejects.toThrow('not allowed');
    });
  });

  describe('custom validation', () => {
    it('calls the custom validator', async () => {
      const customValidator = vi.fn().mockResolvedValue(true);
      const plugin = createFileValidationPlugin({ customValidator });
      const f = file(PNG, 'a.png', 'image/png');
      await run(plugin, f);
      expect(customValidator).toHaveBeenCalledWith(f, 'a.png');
    });

    it('rejects when the custom validator returns false', async () => {
      const plugin = createFileValidationPlugin({ customValidator: () => false });
      await expect(run(plugin, file(PNG, 'a.png', 'image/png'))).rejects.toThrow('custom validation');
    });

    it('calls onValidationFailed', async () => {
      const onValidationFailed = vi.fn();
      const plugin = createFileValidationPlugin({ maxSize: 1, onValidationFailed });
      await expect(run(plugin, PNG)).rejects.toThrow(MediaError);
      expect(onValidationFailed).toHaveBeenCalledWith(expect.objectContaining({ type: 'SIZE' }));
    });
  });
});
