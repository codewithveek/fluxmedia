import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginManager, createPlugin, type FluxMediaPlugin } from '../plugin';

describe('PluginManager', () => {
    let manager: PluginManager;

    beforeEach(() => {
        manager = new PluginManager();
    });

    describe('register', () => {
        it('should register a plugin', async () => {
            const plugin = createPlugin('test', {});
            await manager.register(plugin);

            expect(manager.has('test')).toBe(true);
            expect(manager.size).toBe(1);
        });

        it('should call init when registering', async () => {
            const init = vi.fn();
            const plugin: FluxMediaPlugin = {
                name: 'test',
                hooks: {},
                init,
            };

            await manager.register(plugin);

            expect(init).toHaveBeenCalledTimes(1);
        });

        it('should override plugin with same name (last takes precedence)', async () => {
            const destroy = vi.fn();
            const plugin1: FluxMediaPlugin = {
                name: 'duplicate',
                version: '1.0',
                hooks: {},
                destroy,
            };
            const plugin2: FluxMediaPlugin = {
                name: 'duplicate',
                version: '2.0',
                hooks: {},
            };

            await manager.register(plugin1);
            await manager.register(plugin2);

            expect(manager.size).toBe(1);
            expect(manager.get('duplicate')?.version).toBe('2.0');
            expect(destroy).toHaveBeenCalledTimes(1);
        });
    });

    describe('unregister', () => {
        it('should unregister a plugin', async () => {
            const plugin = createPlugin('test', {});
            await manager.register(plugin);
            const result = await manager.unregister('test');

            expect(result).toBe(true);
            expect(manager.has('test')).toBe(false);
        });

        it('should call destroy when unregistering', async () => {
            const destroy = vi.fn();
            const plugin: FluxMediaPlugin = {
                name: 'test',
                hooks: {},
                destroy,
            };

            await manager.register(plugin);
            await manager.unregister('test');

            expect(destroy).toHaveBeenCalledTimes(1);
        });

        it('should return false for non-existent plugin', async () => {
            const result = await manager.unregister('nonexistent');
            expect(result).toBe(false);
        });
    });

    describe('getAll', () => {
        it('should return plugins in registration order', async () => {
            await manager.register(createPlugin('first', {}));
            await manager.register(createPlugin('second', {}));
            await manager.register(createPlugin('third', {}));

            const plugins = manager.getAll();

            expect(plugins.map(p => p.name)).toEqual(['first', 'second', 'third']);
        });
    });

    describe('clear', () => {
        it('should remove all plugins', async () => {
            await manager.register(createPlugin('test1', {}));
            await manager.register(createPlugin('test2', {}));
            await manager.clear();

            expect(manager.size).toBe(0);
        });

        it('should call destroy on all plugins', async () => {
            const destroy1 = vi.fn();
            const destroy2 = vi.fn();

            await manager.register({ name: 'test1', hooks: {}, destroy: destroy1 });
            await manager.register({ name: 'test2', hooks: {}, destroy: destroy2 });
            await manager.clear();

            expect(destroy1).toHaveBeenCalledTimes(1);
            expect(destroy2).toHaveBeenCalledTimes(1);
        });
    });

    describe('hook execution', () => {
        it('should run beforeUpload hooks in order', async () => {
            const order: string[] = [];

            await manager.register(createPlugin('first', {
                beforeUpload: async (file, options) => {
                    order.push('first');
                    return { file, options: { ...options, folder: 'first' } };
                },
            }));

            await manager.register(createPlugin('second', {
                beforeUpload: async (file, options) => {
                    order.push('second');
                    return { file, options: { ...options, tags: ['second'] } };
                },
            }));

            const buffer = Buffer.from('test');
            const result = await manager.runBeforeUpload(buffer, {});

            expect(order).toEqual(['first', 'second']);
            expect(result.options.folder).toBe('first');
            expect(result.options.tags).toEqual(['second']);
        });

        it('should run afterUpload hooks and modify result', async () => {
            await manager.register(createPlugin('enricher', {
                afterUpload: async (result) => ({
                    ...result,
                    metadata: { ...result.metadata, processed: true },
                }),
            }));

            const mockResult = {
                id: 'test',
                url: 'https://example.com/test.jpg',
                publicUrl: 'https://example.com/test.jpg',
                size: 1024,
                format: 'jpg',
                provider: 'test',
                metadata: {},
                createdAt: new Date(),
            };

            const result = await manager.runAfterUpload(mockResult);

            expect(result.metadata.processed).toBe(true);
        });

        it('should run onError hooks', async () => {
            const errorHandler = vi.fn();

            await manager.register(createPlugin('error-handler', {
                onError: errorHandler,
            }));

            const error = new Error('Test error');
            const context = { file: Buffer.from('test'), options: {} };

            await manager.runOnError(error, context);

            expect(errorHandler).toHaveBeenCalledWith(error, context);
        });

        it('should run beforeDelete and afterDelete hooks', async () => {
            const hookCalls: string[] = [];

            await manager.register(createPlugin('delete-tracker', {
                beforeDelete: async (id) => {
                    hookCalls.push(`before:${id}`);
                    return id;
                },
                afterDelete: async (id) => {
                    hookCalls.push(`after:${id}`);
                },
            }));

            const id = await manager.runBeforeDelete('file-123');
            await manager.runAfterDelete(id);

            expect(hookCalls).toEqual(['before:file-123', 'after:file-123']);
        });
    });
});

describe('createPlugin', () => {
    it('should create a plugin with required properties', () => {
        const plugin = createPlugin('test', {
            beforeUpload: async () => undefined,
        });

        expect(plugin.name).toBe('test');
        expect(plugin.hooks.beforeUpload).toBeDefined();
    });

    it('should support version option', () => {
        const plugin = createPlugin('test', {}, { version: '1.0.0' });

        expect(plugin.version).toBe('1.0.0');
    });
});
