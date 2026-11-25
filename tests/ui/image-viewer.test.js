/**
 * 图片查看器 · 历史列表按需加载
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { openSlotImageViewer } from '../../src/ui/common/image-viewer.js';

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
        if (String(node.className || '').split(/\s+/).includes(className)) out.push(node);
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
        if (String(node.tagName || '').toLowerCase() === 'button') out.push(node);
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
    for (const l of (node._listeners || []).filter((x) => x.type === type)) l.fn(ev);
}

/**
 * @param {number} total
 */
function makeRefs(total) {
    return Array.from({ length: total }, (_, i) => ({ imageRef: `r${i}` }));
}

describe('图片查看器 · 历史按需加载', () => {
    /** @type {{ restore: () => void }} */
    let fake;
    beforeEach(() => {
        fake = installFakeDom();
    });
    afterEach(() => {
        fake.restore();
    });

    it('500 张历史只在打开时解析少量 URL，其余保持占位', async () => {
        /** @type {string[]} */
        const asked = [];
        const viewer = await openSlotImageViewer({}, {
            images: makeRefs(500),
            initialIndex: 499,
            getImageUrl: async (ref) => {
                asked.push(String(ref));
                return `blob:${ref}`;
            },
        });
        assert.ok(viewer, '应打开查看器');
        assert.equal(findAllByClass(document.body, 'nd-image-only__thumbnail').length, 500, '缩略图占位全部存在');
        assert.ok(asked.length > 0, '当前图与邻近缩略图会解析');
        assert.ok(asked.length <= 15, `解析数量应被窗口限制，实际 ${asked.length}`);
        assert.ok(asked.includes('r499'), '当前图必须解析');
        assert.ok(!asked.includes('r0'), '最旧的图不应在打开时解析');

        const img = findAllByClass(document.body, 'nd-image-only__img')[0];
        assert.equal(img.src, 'blob:r499');
        viewer.destroy();
    });

    it('翻到上一张只新增少量解析', async () => {
        /** @type {string[]} */
        const asked = [];
        const viewer = await openSlotImageViewer({}, {
            images: makeRefs(500),
            initialIndex: 499,
            getImageUrl: async (ref) => {
                asked.push(String(ref));
                return `blob:${ref}`;
            },
        });
        const before = asked.length;
        const prev = findButtons(document.body).find((b) => String(b.textContent) === '‹');
        fire(prev, 'click');
        await new Promise((r) => setTimeout(r, 20));

        assert.equal(findAllByClass(document.body, 'nd-image-only__img')[0].src, 'blob:r498');
        assert.ok(asked.length > before, '切换后解析新的一张');
        assert.ok(asked.length - before <= 2, `一次切换最多补一两张，实际新增 ${asked.length - before}`);
        assert.equal(new Set(asked).size, asked.length, '同一张不重复解析');
        viewer.destroy();
    });

    it('已有 url 的图片不会走 getImageUrl', async () => {
        let calls = 0;
        const viewer = await openSlotImageViewer({}, {
            images: [{ url: 'blob:direct', imageRef: 'r1' }],
            getImageUrl: async () => {
                calls += 1;
                return 'blob:fromRepo';
            },
        });
        assert.equal(calls, 0);
        assert.equal(findAllByClass(document.body, 'nd-image-only__img')[0].src, 'blob:direct');
        viewer.destroy();
    });

    it('关闭后不再解析新图，弹层被移除', async () => {
        /** @type {string[]} */
        const asked = [];
        const viewer = await openSlotImageViewer({}, {
            images: makeRefs(40),
            initialIndex: 39,
            getImageUrl: async (ref) => {
                asked.push(String(ref));
                return `blob:${ref}`;
            },
        });
        const before = asked.length;
        const closeBtn = findButtons(document.body).find((b) => String(b.textContent) === '×');
        fire(closeBtn, 'click');
        await new Promise((r) => setTimeout(r, 20));

        assert.equal(findAllByClass(document.body, 'nd-image-only').length, 0, '弹层已移除');
        assert.equal(asked.length, before, '关闭后不再解析');
        viewer.destroy();
    });
});
