/**
 * 存储管理面板 · 图片缓存区
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Ok, Err } from '../../src/infra/result.js';
import { installFakeDom } from './fake-dom.js';
import { mountStoragePanel } from '../../src/ui/panels/storage/storage-panel.js';

/**
 * @param {object} root
 * @param {string} className
 * @returns {object[]}
 */
function findAllByClass(root, className) {
    /** @type {object[]} */
    const out = [];
    function walk(node) {
        if (!node) return;
        if (String(node.className || '').split(/\s+/).includes(className)) {
            out.push(node);
        }
        for (const child of node.childNodes || []) walk(child);
    }
    walk(root);
    return out;
}

/**
 * @param {object} root
 * @returns {object[]}
 */
function findButtons(root) {
    /** @type {object[]} */
    const out = [];
    function walk(node) {
        if (!node) return;
        if (String(node.tagName || '').toLowerCase() === 'button') {
            out.push(node);
        }
        for (const child of node.childNodes || []) walk(child);
    }
    walk(root);
    return out;
}

/**
 * @param {object} node
 * @param {string} type
 */
function fire(node, type) {
    const ev = { preventDefault() {}, stopPropagation() {} };
    for (const l of (node._listeners || []).filter((x) => x.type === type)) {
        l.fn(ev);
    }
}

/**
 * @param {object} btn
 */
function click(btn) {
    const ev = { preventDefault() {}, stopPropagation() {} };
    for (const l of (btn._listeners || []).filter((x) => x.type === 'click')) {
        l.fn(ev);
    }
}

describe('storage-panel image cache', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
    });

    it('shows count/size and trim button reports removed count', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);

        /** @type {object[]} */
        const toasts = [];
        let trimmed = false;
        let saves = 0;
        let estimates = 0;
        const handle = mountStoragePanel(root, {
            host: {
                toast: (level, message) => {
                    toasts.push({ level, message });
                },
                loadSettings: () => ({ imageCacheLimit: 500 }),
                saveSettings: () => { saves += 1; },
            },
            services: {
                storageCleanup: {
                    cleanup: async () => Ok({
                        removedSessions: 0,
                        removedMissingFiles: 0,
                        removedSessionIds: [],
                    }),
                },
                imageCacheTrim: {
                    trim: async (opts) => {
                        assert.deepEqual(opts, { clearAll: true, keep: 0, includeProtected: false });
                        trimmed = true;
                        return Ok({ removed: 2, removedRefs: ['a', 'b'], limit: 0 });
                    },
                },
            },
            repos: {
                image: {
                    estimateUsage: async () => {
                        estimates += 1;
                        return Ok({ bytes: 2048, count: 5, quota: null, usage: null });
                    },
                },
            },
        });

        await new Promise((r) => setTimeout(r, 0));
        const stats = findAllByClass(root, 'nd-storage-stats')[0];
        assert.ok(stats);
        assert.match(String(stats.textContent || ''), /5 张/);
        assert.match(String(stats.textContent || ''), /2\.0 KB/);

        const trimBtn = findButtons(root).find((b) => String(b.textContent || '').includes('清理图片缓存'));
        assert.ok(trimBtn);
        const input = root.querySelector('input');
        input.value = '0';
        click(trimBtn);
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(trimmed, false);
        assert.equal(trimBtn.disabled, true);
        const confirmation = findAllByClass(document.body, 'nd-confirm')[0];
        assert.ok(confirmation);
        assert.match(confirmation.querySelector('p').textContent, /不受缓存上限限制/);
        click(findButtons(confirmation).find((b) => b.textContent === '确认删除'));
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(trimmed, true);
        assert.equal(saves, 0);
        assert.equal(estimates, 2);
        assert.equal(trimBtn.disabled, false);
        assert.ok(toasts.some((t) => String(t.message).includes('已清理 2 张图片缓存')));

        handle.destroy();
    });

    it('取消确认不清理；再次确认零张时显示无可清理缓存', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        let trims = 0;
        let saves = 0;
        const toasts = [];
        const handle = mountStoragePanel(root, {
            host: {
                loadSettings: () => ({ imageCacheLimit: 500 }),
                saveSettings: () => { saves += 1; },
                toast: (level, message) => toasts.push({ level, message }),
            },
            services: { imageCacheTrim: { trim: async () => {
                trims += 1;
                return Ok({ removed: 0, removedRefs: [], limit: 0 });
            } } },
        });
        const button = findButtons(root).find((b) => b.textContent === '清理图片缓存');
        click(button);
        await new Promise((resolve) => setTimeout(resolve, 0));
        let confirmation = findAllByClass(document.body, 'nd-confirm')[0];
        click(findButtons(confirmation).find((b) => b.textContent === '取消'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(trims, 0);
        assert.equal(saves, 0);
        assert.equal(button.disabled, false);
        assert.deepEqual(toasts, []);
        click(button);
        await new Promise((resolve) => setTimeout(resolve, 0));
        confirmation = findAllByClass(document.body, 'nd-confirm')[0];
        click(findButtons(confirmation).find((b) => b.textContent === '确认删除'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(trims, 1);
        assert.ok(toasts.some((t) => t.level === 'info' && t.message.includes('没有可清理的图片缓存')));
        handle.destroy();
    });

    it('trim failure shows reason', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);

        /** @type {object[]} */
        const toasts = [];
        const handle = mountStoragePanel(root, {
            host: {
                toast: (level, message) => {
                    toasts.push({ level, message });
                },
                loadSettings: () => ({ imageCacheLimit: 500 }),
                saveSettings: () => {},
            },
            services: {
                imageCacheTrim: {
                    trim: async () => Err({
                        code: 'X', message: '磁盘只读', category: 'storage',
                    }),
                },
            },
            repos: {
                image: {
                    estimateUsage: async () => Ok({
                        bytes: 0, count: 0, quota: null, usage: null,
                    }),
                },
            },
        });
        await new Promise((r) => setTimeout(r, 0));
        const trimBtn = findButtons(root).find((b) => String(b.textContent || '').includes('清理图片缓存'));
        assert.ok(trimBtn);
        click(trimBtn);
        await new Promise((r) => setTimeout(r, 0));
        const confirmation = findAllByClass(document.body, 'nd-confirm')[0];
        click(findButtons(confirmation).find((b) => b.textContent === '确认删除'));
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(trimBtn.disabled, false);
        assert.ok(toasts.some((t) => t.level === 'error' && String(t.message).includes('磁盘只读')));
        handle.destroy();
    });

    it('图库每页最多 20 张，翻页释放上一页 URL', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const total = 45;
        const metas = Array.from({ length: total }, (_, i) => ({
            id: `img${i}`,
            size: 1024,
            createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}`,
            pinned: false,
            mimeType: 'image/png',
        }));
        /** @type {string[]} */
        const released = [];
        const handle = mountStoragePanel(root, {
            host: { toast: () => {}, loadSettings: () => ({ imageCacheLimit: 500 }), saveSettings: () => {} },
            services: { imageCacheTrim: { trim: async () => Ok({ removed: 0, removedRefs: [], limit: 0 }) } },
            repos: {
                image: {
                    estimateUsage: async () => Ok({ bytes: total * 1024, count: total, quota: null, usage: null }),
                    listMeta: async () => Ok(metas),
                    getUrl: async (id) => Ok(`blob:${id}`),
                    getBlob: async () => Ok(new Blob(['x'], { type: 'image/png' })),
                    releaseUrl: (id) => released.push(String(id)),
                },
            },
        });
        await new Promise((r) => setTimeout(r, 10));

        assert.equal(findAllByClass(root, 'nd-cache-card').length, 20, '首屏最多渲染 20 张');
        const pagerInfo = findAllByClass(root, 'nd-cache-pager')[0]?.querySelector('span');
        assert.match(String(pagerInfo.textContent || ''), /第 1 \/ 3 页/);

        const next = findButtons(root).find((b) => String(b.textContent || '') === '下一页');
        click(next);
        await new Promise((r) => setTimeout(r, 10));

        assert.equal(findAllByClass(root, 'nd-cache-card').length, 20, '第二页 20 张');
        assert.equal(released.length, 20, '翻页时释放上一页 20 个 URL');
        assert.match(String(pagerInfo.textContent || ''), /第 2 \/ 3 页/);

        click(next);
        await new Promise((r) => setTimeout(r, 10));

        assert.equal(findAllByClass(root, 'nd-cache-card').length, 5, '最后一页只剩 5 张');
        assert.equal(released.length, 40, '再次翻页释放第二页 20 个 URL');
        assert.match(String(pagerInfo.textContent || ''), /第 3 \/ 3 页/);
        assert.equal(next.disabled, true);

        handle.destroy();
        assert.equal(released.length, 45, '关闭面板释放当前页 URL');
    });

    it('清理选项把保留张数与受保护开关传给服务', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        /** @type {object[]} */
        const calls = [];
        const handle = mountStoragePanel(root, {
            host: { toast: () => {}, loadSettings: () => ({ imageCacheLimit: 500 }), saveSettings: () => {} },
            services: {
                imageCacheTrim: {
                    trim: async (opts) => {
                        calls.push(opts);
                        return Ok({ removed: 4, removedRefs: [], limit: 0 });
                    },
                },
            },
        });
        await new Promise((r) => setTimeout(r, 0));

        const inputs = root.querySelectorAll('input');
        inputs[1].value = '10';
        inputs[2].checked = true;
        fire(inputs[2], 'change');

        const trimBtn = findButtons(root).find((b) => String(b.textContent || '').includes('清理图片缓存'));
        click(trimBtn);
        await new Promise((r) => setTimeout(r, 0));
        const confirmation = findAllByClass(document.body, 'nd-confirm')[0];
        assert.match(confirmation.querySelector('p').textContent, /保留最近 10 张/);
        assert.match(confirmation.querySelector('p').textContent, /受保护图片/);
        click(findButtons(confirmation).find((b) => b.textContent === '确认删除'));
        await new Promise((r) => setTimeout(r, 0));

        assert.deepEqual(calls, [{ clearAll: true, keep: 10, includeProtected: true }]);
        handle.destroy();
    });
});
