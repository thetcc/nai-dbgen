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
                        assert.deepEqual(opts, { clearAll: true });
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
        assert.ok(toasts.some((t) => String(t.message).includes('已清理 2 张本地缓存图片')));

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
});
