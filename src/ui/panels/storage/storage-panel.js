/**
 * L5 UI · 存储管理：会话记录清理 + 图片缓存上限（需求 4.17）。
 */

import { createButton, createCheckbox, createInlineError, createNumberField } from '../../common/controls.js';
import { openSlotImageViewer } from '../../common/image-viewer.js';
import { detectImageMime, imageExtension, requestImageDownload } from '../../common/image-download.js';
import { readPngCaption } from '../../common/png-caption.js';
import { matchImageArtist } from '../../common/image-artist-match.js';
import { confirmDanger, el, setText, toast, settingsApi } from '../_lib/panel-kit.js';

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 图库每页最多渲染的张数。一张未压缩位图约 4MB（832×1216 RGBA），
 * 全部挂到 DOM 会瞬间吃光内存，所以分页 + 翻页即释放，保证同时存活 ≤ 该值。
 */
const GALLERY_PAGE_SIZE = 30;

/**
 * @param {Element} root
 * @param {object} deps
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export function mountStoragePanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountStoragePanel: root must be an Element');
    }

    const host = deps?.host;
    const cleanupService = deps?.services?.storageCleanup
        || deps?.storageCleanup;
    const trimService = deps?.services?.imageCacheTrim
        || deps?.imageCacheTrim;
    const imageRepo = deps?.repos?.image
        || deps?.imageRepo;
    const settings = settingsApi(deps);

    const shell = el('div', 'nd-panel nd-panel--storage');

    // ── 会话记录 ──────────────────────────────────────────────
    const sessionBlock = el('div', 'nd-storage-block');
    const sessionTitle = el('h3', 'nd-storage-block__title');
    setText(sessionTitle, '会话生图记录');
    const sessionErr = createInlineError();
    const sessionHint = el('p', 'nd-muted');
    setText(
        sessionHint,
        '清理已从酒馆删除的会话对应的生图记录。此操作不可撤销。',
    );
    const sessionResult = el('p', 'nd-storage-result nd-muted');
    sessionResult.hidden = true;
    const cleanBtn = createButton({
        label: '清理',
        variant: 'danger',
        onClick: () => void runSessionCleanup(),
    });
    sessionBlock.append(sessionTitle, sessionErr.el, sessionHint, cleanBtn, sessionResult);

    // ── 图片缓存 ──────────────────────────────────────────────
    const cacheBlock = el('div', 'nd-storage-block');
    const cacheTitle = el('h3', 'nd-storage-block__title');
    setText(cacheTitle, '图片缓存');
    const cacheErr = createInlineError();
    const cacheHint = el('p', 'nd-muted');
    setText(
        cacheHint,
        '楼层出的图保存在本机浏览器。启动时按上限从最旧的开始裁剪；手动清理只清空图片缓存，不受上限限制。图库每页最多显示 30 张，翻页会释放上一页图片内存。仅影响图片与对应楼层图片索引，角色卡、标签、预设、画师、LLM/NAI 配置等其他数据均保留；受保护图片和画师图库默认也保留。',
    );
    const statsEl = el('p', 'nd-storage-stats');
    setText(statsEl, '当前：—');

    const limitField = createNumberField({
        label: '缓存上限（张）',
        value: Number(settings.load()?.imageCacheLimit) || 500,
        min: 1,
        step: 1,
        onChange: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1) {
                cacheErr.setMessage('上限必须是 ≥1 的整数');
                return;
            }
            cacheErr.clear();
            settings.patch({ imageCacheLimit: n });
        },
    });

    const cacheResult = el('p', 'nd-storage-result nd-muted');
    cacheResult.hidden = true;
    const gallery = el('div', 'nd-cache-gallery');
    let selecting = false;
    let galleryItems = [];
    /** 全量元数据（不含 objectURL，成本很低），用于统计/翻页/跨页下载 */
    let allMeta = [];
    let galleryPage = 0;
    let galleryPageCount = 1;
    /** 当前页已创建的 objectURL（imageRef → url），翻页或关闭面板时统一释放 */
    const pageUrls = new Map();
    const selectedIds = new Set();
    const selectionBar = el('div', 'nd-cache-selection');
    const bulk = el('div', 'nd-cache-selection__bulk');
    bulk.hidden = true;
    const counter = el('span', 'nd-muted');
    const selectButton = createButton({ label: '选择', variant: 'ghost', onClick: () => {
        selecting = !selecting;
        if (!selecting) selectedIds.clear();
        selectButton.textContent = selecting ? '完成' : '选择';
        bulk.hidden = !selecting;
        syncSelection();
    }});
    const selectAll = createButton({ label: '全选', variant: 'ghost', onClick: () => { for (const row of galleryItems) selectedIds.add(String(row.id)); syncSelection(); } });
    const selectNone = createButton({ label: '取消选择', variant: 'ghost', onClick: () => { selectedIds.clear(); syncSelection(); } });
    const download = createButton({ label: '下载所选', variant: 'primary', onClick: () => {
        void runDownloadSelected();
    }});
    bulk.append(selectAll, selectNone, download, counter);
    selectionBar.append(selectButton, bulk);
    const pagerBar = el('div', 'nd-cache-pager');
    const pagerPrev = createButton({ label: '上一页', variant: 'ghost', onClick: () => {
        if (galleryPage <= 0) return;
        galleryPage -= 1;
        void paintGallery();
    } });
    const pagerInfo = el('span', 'nd-muted');
    const pagerNext = createButton({ label: '下一页', variant: 'ghost', onClick: () => {
        if (galleryPage >= galleryPageCount - 1) return;
        galleryPage += 1;
        void paintGallery();
    } });
    pagerBar.append(pagerPrev, pagerInfo, pagerNext);
    pagerBar.hidden = true;

    const keepField = createNumberField({
        label: '清理后保留最近（张，0 = 全部清理）',
        value: 0,
        min: 0,
        step: 1,
    });
    const includeProtectedBox = createCheckbox({
        label: '同时清理受保护图片（工作台最近出图）',
        checked: false,
    });

    const trimBtn = createButton({
        label: '清理图片缓存',
        variant: 'danger',
        onClick: () => void runImageTrim(),
    });
    cacheBlock.append(
        cacheTitle,
        cacheErr.el,
        cacheHint,
        statsEl,
        selectionBar,
        gallery,
        pagerBar,
        limitField.el,
        keepField.el,
        includeProtectedBox.el,
        trimBtn,
        cacheResult,
    );

    shell.append(sessionBlock, cacheBlock);
    root.appendChild(shell);

    let destroyed = false;

    async function refreshStats() {
        if (destroyed) {
            return;
        }
        if (!imageRepo || typeof imageRepo.estimateUsage !== 'function') {
            setText(statsEl, '当前：暂不可用');
            return;
        }
        try {
            const r = await imageRepo.estimateUsage();
            if (destroyed) {
                return;
            }
            if (!r?.ok) {
                setText(statsEl, '当前：读取失败');
                return;
            }
            const { count, bytes } = r.value;
            setText(statsEl, `当前：${count} 张，约 ${formatBytes(bytes)}`);
            await paintGallery();
        } catch {
            if (!destroyed) {
                setText(statsEl, '当前：读取失败');
            }
        }
    }

    function syncSelection() {
        bulk.hidden = !selecting;
        counter.textContent = `已选 ${selectedIds.size}`;
        const waiting = galleryItems.some((row) => selectedIds.has(String(row.id)) && row.loading);
        download.disabled = selectedIds.size === 0 || waiting;
        for (const row of galleryItems) {
            if (!row.card || !row.checkbox) continue;
            row.checkbox.hidden = !selecting;
            row.checkbox.checked = selectedIds.has(String(row.id));
            row.reuse.hidden = selecting;
            row.card.classList.toggle('is-selected', selecting && row.checkbox.checked);
        }
    }

    /** 释放当前页创建的 objectURL：翻页/重绘/关闭面板时调用，避免旧图常驻内存。 */
    function releaseGalleryUrls() {
        for (const [ref, url] of pageUrls) {
            try {
                if (imageRepo && typeof imageRepo.releaseUrl === 'function') {
                    imageRepo.releaseUrl(ref);
                } else if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                    URL.revokeObjectURL(url);
                }
            } catch {
                // ignore
            }
        }
        pageUrls.clear();
    }

    function updatePager(total) {
        const pageCount = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
        galleryPageCount = pageCount;
        pagerBar.hidden = total <= GALLERY_PAGE_SIZE;
        if (pagerBar.hidden) {
            setText(pagerInfo, '');
            return;
        }
        setText(
            pagerInfo,
            `第 ${galleryPage + 1} / ${pageCount} 页 · 每页最多 ${GALLERY_PAGE_SIZE} 张，翻页会释放上一页图片内存`,
        );
        pagerPrev.disabled = galleryPage <= 0;
        pagerNext.disabled = galleryPage >= pageCount - 1;
    }

    async function paintGallery() {
        releaseGalleryUrls();
        gallery.replaceChildren();
        if (!imageRepo || typeof imageRepo.listMeta !== 'function' || typeof imageRepo.getUrl !== 'function') {
            return;
        }
        const listed = await imageRepo.listMeta();
        if (destroyed || !listed?.ok) {
            return;
        }
        allMeta = listed.value;
        const total = allMeta.length;
        galleryPageCount = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
        if (galleryPage > galleryPageCount - 1) galleryPage = galleryPageCount - 1;
        if (galleryPage < 0) galleryPage = 0;
        const start = galleryPage * GALLERY_PAGE_SIZE;
        galleryItems = allMeta
            .slice(start, start + GALLERY_PAGE_SIZE)
            .map((item) => ({ ...item, url: null, loading: true, card: null, checkbox: null, reuse: null }));
        const activeIds = new Set(allMeta.map((row) => String(row.id)));
        for (const id of selectedIds) if (!activeIds.has(id)) selectedIds.delete(id);
        syncSelection();
        if (!total) {
            pagerBar.hidden = true;
            const empty = el('p', 'nd-muted');
            setText(empty, '没有缓存图片');
            gallery.appendChild(empty);
            return;
        }
        updatePager(total);
        for (const row of galleryItems) {
            const card = document.createElement('div');
            card.className = 'nd-cache-card';
            card.tabIndex = 0;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'nd-cache-card__select';
            checkbox.setAttribute('aria-label', '选择图片');
            checkbox.addEventListener('click', (event) => event.stopPropagation());
            checkbox.addEventListener('keydown', (event) => event.stopPropagation());
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selectedIds.add(String(row.id)); else selectedIds.delete(String(row.id));
                syncSelection();
            });
            card.appendChild(checkbox);
            const img = document.createElement('img');
            img.alt = '';
            img.className = 'nd-cache-card__img';
            img.loading = 'lazy';
            card.appendChild(img);
            const cap = el('span', 'nd-cache-card__cap');
            const title = `${row.pinned ? '画师参考 · ' : ''}${formatBytes(row.size)}`;
            setText(cap, title);
            card.appendChild(cap);
            const reuse = document.createElement('button');
            reuse.type = 'button';
            reuse.className = 'nd-button nd-button--primary nd-cache-card__reuse';
            reuse.textContent = '复用到工作台';
            reuse.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (reuse.disabled) return;
                reuse.disabled = true;
                try {
                    if (!deps.importToWorkbench || !imageRepo.getBlob) throw new Error('工作台或图片读取功能不可用');
                    const result = await imageRepo.getBlob(row.id);
                    if (!result?.ok || !result.value) throw new Error('读取图片失败');
                    const caption = await readPngCaption(result.value);
                    const listedArtists = await deps.repos?.artist?.list?.();
                    if (listedArtists && !listedArtists.ok) throw new Error('画师串库读取失败，未导入图片');
                    const matched = matchImageArtist(caption, listedArtists?.value || []);
                    if (destroyed) return;
                    await deps.importToWorkbench(matched.artist
                        ? { artistId: matched.artist.id, caption: matched.caption }
                        : { caption });
                    if (!matched.artist) {
                        toast(host, 'warning', '未匹配到唯一的画师串，已将完整提示词导入场景。工作台原有画师串未改变，请检查是否重复。');
                    }
                } catch (error) {
                    toast(host, 'error', error?.message || '图片提示词导入失败');
                } finally {
                    reuse.disabled = false;
                }
            });
            reuse.addEventListener('keydown', (event) => event.stopPropagation());
            card.appendChild(reuse);
            row.card = card; row.checkbox = checkbox; row.reuse = reuse;
            checkbox.hidden = !selecting;
            checkbox.checked = selectedIds.has(String(row.id));
            reuse.hidden = selecting;
            card.classList.toggle('is-selected', selecting && checkbox.checked);
            gallery.appendChild(card);
            const open = () => {
                if (selecting) {
                    if (selectedIds.has(String(row.id))) selectedIds.delete(String(row.id)); else selectedIds.add(String(row.id));
                    syncSelection();
                    return;
                }
                if (row.url) void openSlotImageViewer({ host }, { url: row.url, title, alt: title, getImageBlob: async () => {
                    const result = await imageRepo.getBlob?.(row.id);
                    return result?.ok ? result.value : null;
                }, images: [{ url: row.url, imageRef: row.id }] });
            };
            card.addEventListener('click', open);
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
            });
            try {
                const urlR = await imageRepo.getUrl(row.id);
                if (destroyed) return;
                row.url = urlR?.ok ? urlR.value : null;
                if (row.url) {
                    img.src = row.url;
                    pageUrls.set(String(row.id), row.url);
                }
                if (row.url && !imageExtension(row.mimeType, row.url) && typeof imageRepo.getBlob === 'function') {
                    const got = await imageRepo.getBlob(row.id);
                    if (got?.ok && got.value) row.mimeType = await detectImageMime(got.value);
                }
            } catch { row.url = null; }
            finally { row.loading = false; if (selecting && selectedIds.has(String(row.id))) syncSelection(); }
        }
    }

    async function runSessionCleanup() {
        if (destroyed) {
            return;
        }
        sessionErr.clear();
        sessionResult.hidden = true;
        if (!cleanupService || typeof cleanupService.cleanup !== 'function') {
            sessionErr.setMessage('清理功能暂不可用，请刷新后重试');
            return;
        }
        const confirmed = await confirmDanger(
            deps,
            '将删除已不在酒馆中的会话生图记录。此操作不可撤销，确定继续？',
        );
        if (!confirmed || destroyed) {
            return;
        }
        cleanBtn.disabled = true;
        try {
            const r = await cleanupService.cleanup();
            if (!r?.ok) {
                const msg = r?.error?.message || '清理失败';
                sessionErr.setMessage(msg);
                toast(host, 'error', msg);
                return;
            }
            const { removedSessions, removedMissingFiles } = r.value;
            const text = `清理完成：删除无效会话 ${removedSessions} 个，清理无效登记 ${removedMissingFiles} 个。`;
            setText(sessionResult, text);
            sessionResult.hidden = false;
            toast(host, 'success', text);
        } catch (cause) {
            const msg = cause instanceof Error ? cause.message : '清理失败';
            sessionErr.setMessage(msg);
            toast(host, 'error', msg);
        } finally {
            cleanBtn.disabled = false;
        }
    }

    async function runDownloadSelected() {
        if (destroyed || !selectedIds.size) {
            return;
        }
        download.disabled = true;
        let sent = 0;
        const failed = [];
        try {
            for (const id of selectedIds) {
                try {
                    if (!imageRepo || typeof imageRepo.getBlob !== 'function') {
                        throw new Error('图片读取功能不可用');
                    }
                    const got = await imageRepo.getBlob(id);
                    if (!got?.ok || !got.value) {
                        throw new Error('图片不可用');
                    }
                    const blob = got.value;
                    const url = URL.createObjectURL(blob);
                    try {
                        requestImageDownload(url, blob.type || '');
                    } finally {
                        URL.revokeObjectURL(url);
                    }
                    sent += 1;
                } catch {
                    failed.push(String(id));
                }
            }
        } finally {
            download.disabled = false;
        }
        if (failed.length) toast(host, 'warning', `${failed.length} 张图片无法读取或下载`);
        if (sent) toast(host, 'info', `已请求下载 ${sent} 张；如浏览器询问，请允许下载多个文件，并检查下载列表`);
    }

    async function runImageTrim() {
        if (destroyed || trimBtn.disabled) {
            return;
        }
        cacheErr.clear();
        cacheResult.hidden = true;
        if (!trimService || typeof trimService.trim !== 'function') {
            cacheErr.setMessage('清理图片缓存暂不可用，请刷新后重试');
            return;
        }
        const keepRaw = keepField.getValue();
        if (!Number.isInteger(keepRaw) || keepRaw < 0) {
            cacheErr.setMessage('保留张数必须是 ≥0 的整数（0 表示全部清理）');
            return;
        }
        const keep = keepRaw;
        const includeProtected = includeProtectedBox.getValue() === true;
        const scope = includeProtected
            ? '图片缓存，并把受保护图片（工作台最近出图）也纳入清理'
            : '图片缓存（受保护图片与画师图库保留）';
        const keepText = keep > 0
            ? `按出图时间保留最近 ${keep} 张，其余删除。`
            : '不保留最近的图片，全部删除。';
        trimBtn.disabled = true;
        try {
            const confirmed = await confirmDanger(
                deps,
                `仅清理${scope}，不受缓存上限限制。${keepText}角色卡、标签、预设、画师、LLM/NAI 配置等其他数据不受影响；服务器生图记录也不受影响。此操作不可撤销，确定继续？`,
            );
            if (!confirmed || destroyed) {
                return;
            }
            const r = await trimService.trim({ clearAll: true, keep, includeProtected });
            if (!r?.ok) {
                const msg = r?.error?.message || '清理图片缓存失败';
                cacheErr.setMessage(msg);
                toast(host, 'error', msg);
                return;
            }
            const removed = Number(r.value?.removed) || 0;
            const keptText = keep > 0 ? `，保留最近 ${keep} 张` : '';
            const text = removed > 0
                ? `已清理 ${removed} 张图片缓存${keptText}。`
                : `没有可清理的图片缓存${includeProtected ? '' : '（受保护图片仍在，可勾选“同时清理受保护图片”再清）'}。`;
            setText(cacheResult, text);
            cacheResult.hidden = false;
            toast(host, removed > 0 ? 'success' : 'info', text);
            galleryPage = 0;
            await refreshStats();
        } catch (cause) {
            const msg = cause instanceof Error ? cause.message : '清理图片缓存失败';
            cacheErr.setMessage(msg);
            toast(host, 'error', msg);
        } finally {
            trimBtn.disabled = false;
        }
    }

    void refreshStats();

    return {
        async refresh() {
            const current = Number(settings.load()?.imageCacheLimit) || 500;
            limitField.setValue(current);
            await refreshStats();
        },
        destroy() {
            destroyed = true;
            releaseGalleryUrls();
            for (const field of [limitField, keepField, includeProtectedBox]) {
                try {
                    field.destroy?.();
                } catch {
                    // ignore
                }
            }
            shell.remove();
        },
    };
}
