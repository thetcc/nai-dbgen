/**
 * 图片缓存上限裁剪服务（需求 4.17）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIdb } from '../../src/adapters/storage/memory-idb.js';
import { createImageRepo } from '../../src/adapters/storage/image.repo.js';
import { IDB_STORES } from '../../src/adapters/storage/idb.js';
import { createImageCacheTrimService } from '../../src/application/image-cache-trim.service.js';
import { APP_EVENTS } from '../../src/application/_helpers.js';
import { createEventBus } from '../../src/infra/event-bus.js';
import { isOk, isErr } from '../../src/infra/result.js';

describe('image-cache-trim.service', () => {
    it('reads limit, trims oldest, emits IMAGE_CACHE_TRIMMED', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        await db.put(IDB_STORES.IMAGES, {
            id: 'a', blob, mimeType: 'image/png', size: 1,
            createdAt: '2020-01-01T00:00:00.000Z',
        });
        await db.put(IDB_STORES.IMAGES, {
            id: 'b', blob, mimeType: 'image/png', size: 1,
            createdAt: '2021-01-01T00:00:00.000Z',
        });
        await db.put(IDB_STORES.IMAGES, {
            id: 'c', blob, mimeType: 'image/png', size: 1,
            createdAt: '2022-01-01T00:00:00.000Z',
        });
        await imageRepo.linkSlot('s', 1, 'a');

        const bus = createEventBus();
        /** @type {unknown[]} */
        const events = [];
        bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, (p) => events.push(p));

        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 2 }),
            imageRepo,
            bus,
        });
        const r = await svc.trim();
        assert.equal(isOk(r), true);
        assert.equal(r.value.removed, 1);
        assert.deepEqual(r.value.removedRefs, ['a']);
        assert.equal(r.value.limit, 2);
        assert.equal(events.length, 1);
        assert.deepEqual(/** @type {any} */ (events[0]).removedRefs, ['a']);
        assert.equal(await db.get(IDB_STORES.SLOT_IMAGE_CACHE, ['s', 1]), undefined);
    });

    it('under limit does not emit', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        await imageRepo.put(blob);

        const bus = createEventBus();
        let emitted = false;
        bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, () => {
            emitted = true;
        });

        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 500 }),
            imageRepo,
            bus,
        });
        const r = await svc.trim();
        assert.equal(isOk(r), true);
        assert.equal(r.value.removed, 0);
        assert.equal(emitted, false);
    });

    it('defaults to 500 when settings omit limit', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        /** @type {number|null} */
        let seenLimit = null;
        const wrapped = {
            trimToLimit: async (limit) => {
                seenLimit = limit;
                return imageRepo.trimToLimit(limit);
            },
        };
        const svc = createImageCacheTrimService({
            loadSettings: () => ({}),
            imageRepo: wrapped,
        });
        const r = await svc.trim();
        assert.equal(isOk(r), true);
        assert.equal(seenLimit, 500);
    });

    it('显式清空忽略设置上限，保留保护图，并发送完整删除事件；重复清空不发事件', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        const blob = new Blob(['x']);
        await imageRepo.put(blob);
        await imageRepo.put(blob);
        await imageRepo.put(blob, { pinned: true });
        await imageRepo.put(blob, { id: 'artist' });
        const events = [];
        const bus = createEventBus();
        bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, (payload) => events.push(payload));
        const svc = createImageCacheTrimService({
            loadSettings: () => { assert.fail('手动清空不应读取上限'); },
            imageRepo,
            bus,
        });
        const r = await svc.trim({ clearAll: true });
        assert.equal(isOk(r), true);
        assert.equal(r.value.removed, 2);
        assert.equal(r.value.limit, 0);
        assert.equal(r.value.removedRefs.length, 2);
        assert.deepEqual(events, [r.value]);
        assert.notEqual(events[0].removedRefs, r.value.removedRefs);
        assert.equal((await db.getAll(IDB_STORES.IMAGES)).length, 1);
        assert.ok((await imageRepo.getBlob('artist')).value);
        assert.equal((await svc.trim({ clearAll: true })).value.removed, 0);
        assert.equal(events.length, 1);
    });

    it('clearAll 为 false 时仍按设置上限裁剪', async () => {
        const seen = [];
        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 7 }),
            imageRepo: { trimToLimit: async (...args) => {
                seen.push(args);
                return { ok: true, value: { removed: 0, removedRefs: [] } };
            } },
        });
        await svc.trim({ clearAll: false });
        assert.deepEqual(seen, [[7]]);
    });

    it('手动清空透传仓库错误且不发事件', async () => {
        const events = [];
        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 500 }),
            imageRepo: { trimToLimit: async (limit, opts) => {
                assert.equal(limit, 0);
                assert.deepEqual(opts, { clearAll: true });
                return { ok: false, error: { code: 'X', message: '失败', category: 'storage' } };
            } },
            bus: { emit: (...args) => events.push(args) },
        });
        assert.equal((await svc.trim({ clearAll: true })).error.code, 'X');
        assert.deepEqual(events, []);
    });

    it('propagates repo errors without throwing', async () => {
        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 3 }),
            imageRepo: {
                trimToLimit: async () => ({
                    ok: false,
                    error: { code: 'X', message: 'boom', category: 'config' },
                }),
            },
        });
        const r = await svc.trim();
        assert.equal(isErr(r), true);
        assert.equal(r.error.code, 'X');
    });
});
