/**
 * L5 UI · 图片查看器（宿主 Popup / openModal）。
 * 归属：W1-E 公共组件（原 slot-widget，供面板/控件共用）。
 *
 * 凡写 img.src 必须过 safeImageUrl（D24）。
 */

import { safeImageUrl } from './safe-url.js';
import { detectImageMime, imageExtension, requestImageDownload } from './image-download.js';

/**
 * 构建查看器内容根（带 .nd-root，令牌生效；D52 不用 id）。
 * @param {string} safeUrl 已过白名单
 * @param {string} [alt]
 * @returns {HTMLElement}
 */
export function buildImageViewerElement(safeUrl, alt) {
    const root = document.createElement('div');
    root.className = 'nd-root nd-slot-viewer';

    const img = document.createElement('img');
    img.className = 'nd-slot-viewer__img';
    img.src = safeUrl;
    img.alt = alt == null ? '' : String(alt);
    root.appendChild(img);
    return root;
}

/**
 * 缩略图按需加载：只为当前图前后各 THUMB_WINDOW 张解析 URL，
 * 其余保持空白占位（滚到附近时再由 IntersectionObserver 补上）。
 * 这样即使历史有 500 张，同时驻留的 objectURL 也只有十几条。
 */
const THUMB_WINDOW = 5;

/**
 * 打开大图。URL 未过白名单则返回 null（不弹窗）。
 * @param {object} deps
 * @param {import('../../ports/host.port.js').HostPort} [deps.host]
 * @param {object} opts
 * @param {unknown} opts.url
 * @param {string} [opts.title]
 * @param {string} [opts.alt]
 * @returns {Promise<{ destroy: () => void }|null>}
 */
export async function openSlotImageViewer(_deps, opts) {
    const sources = Array.isArray(opts?.images) && opts.images.length
        ? opts.images
        : [{ url: opts?.url, alt: opts?.alt }];
    const ownedSourceUrls = [];
    /** @type {Array<object>} 只保留可展示的项；仅有 imageRef 的项在需要时再解析 URL */
    const images = [];
    sources.forEach((item, sourceIndex) => {
        /** @type {Record<string, unknown>} */
        const entry = { ...item, sourceIndex, url: null };
        if (item?.blob instanceof Blob) {
            try {
                const created = URL.createObjectURL(item.blob);
                ownedSourceUrls.push(created);
                entry.url = created;
            } catch {
                entry.url = null;
            }
        } else if (item?.url) {
            entry.url = item.url;
        }
        if (entry.url) {
            const safe = safeImageUrl(entry.url);
            if (!safe) return;
            entry.url = safe;
            images.push(entry);
            return;
        }
        // 没有现成 URL，但有 imageRef 时可稍后按需解析（历史列表走这条路径）
        if (item?.imageRef != null && typeof opts?.getImageUrl === 'function') {
            images.push(entry);
        }
    });
    if (!images.length) return null;
    let index = images.findIndex((item) => item.sourceIndex === opts?.initialIndex);
    if (index < 0) index = images.length - 1;
    const overlay = document.createElement('dialog');
    overlay.className = 'nd-image-only';
    overlay.setAttribute('aria-label', opts?.title || '图片历史');
    const toolbar = document.createElement('div');
    toolbar.className = 'nd-image-only__toolbar';
    const strip = document.createElement('div');
    strip.className = 'nd-image-only__history';
    const count = document.createElement('span');
    count.setAttribute('aria-live', 'polite');
    const error = document.createElement('span');
    error.className = 'nd-image-only__error';
    error.textContent = '图片缓存已清理或不可用';
    error.hidden = true;
    const img = document.createElement('img');
    img.className = 'nd-image-only__img';
    img.title = '三击图片下载';
    img.addEventListener('error', () => { error.hidden = false; });
    img.addEventListener('load', () => { error.hidden = true; });
    function button(symbol, label, click) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'nd-image-only__button';
        node.textContent = symbol;
        node.title = label;
        node.setAttribute('aria-label', label);
        node.addEventListener('click', click);
        return node;
    }
    const previous = button('‹', '上一张', () => select(index - 1));
    const next = button('›', '下一张', () => select(index + 1));
    const closeButton = button('×', '关闭图片历史', () => close());
    let closed = false;
    let selectSequence = 0;

    /** @type {HTMLImageElement[]} */
    const thumbPreviews = [];
    const thumbs = images.map((_item, i) => {
        const thumb = button('', `历史图片 ${i + 1}`, () => select(i));
        thumb.className = 'nd-image-only__thumbnail';
        const preview = document.createElement('img');
        preview.alt = '';
        preview.loading = 'lazy';
        thumbPreviews[i] = preview;
        thumb.appendChild(preview);
        strip.appendChild(thumb);
        return thumb;
    });

    /** @type {Map<number, Promise<string|null>>} 同一张的并发解析只发一次请求 */
    const pendingUrl = new Map();

    /**
     * 按需解析第 i 张的 URL。已有 URL 直接复用；仅有 imageRef 时走 getImageUrl。
     * @param {number} i
     * @returns {Promise<string|null>}
     */
    function resolveAt(i) {
        const item = images[i];
        if (!item) return Promise.resolve(null);
        if (item.url) return Promise.resolve(item.url);
        if (item.imageRef == null || typeof opts?.getImageUrl !== 'function') return Promise.resolve(null);
        const inflight = pendingUrl.get(i);
        if (inflight) return inflight;
        const task = (async () => {
            try {
                const safe = safeImageUrl(await opts.getImageUrl(item.imageRef));
                if (safe) item.url = safe;
                return safe;
            } catch {
                return null;
            } finally {
                pendingUrl.delete(i);
            }
        })();
        pendingUrl.set(i, task);
        return task;
    }

    /** @type {('idle'|'loading'|'loaded'|'failed')[]} 缩略图加载状态，避免重复解析 */
    const thumbState = images.map(() => 'idle');

    /** 让第 i 个缩略图开始加载（已加载/加载中则跳过）。 */
    function ensureThumb(i) {
        const preview = thumbPreviews[i];
        const item = images[i];
        if (!preview || !item || thumbState[i] !== 'idle') return;
        thumbState[i] = 'loading';
        if (item.url) {
            preview.src = item.url;
            thumbState[i] = 'loaded';
            return;
        }
        void resolveAt(i).then((url) => {
            if (closed) return;
            if (!url) {
                thumbState[i] = 'failed';
                return;
            }
            preview.src = url;
            thumbState[i] = 'loaded';
        });
    }

    /** 释放离当前图较远的缩略图，避免 500 张全部解码占内存。 */
    function clearThumb(i) {
        if (thumbState[i] !== 'loaded') return;
        thumbState[i] = 'idle';
        const preview = thumbPreviews[i];
        if (!preview) return;
        if (typeof preview.removeAttribute === 'function') preview.removeAttribute('src');
        else preview.src = '';
    }

    /** 只保留当前图附近窗口内的缩略图加载，其余释放。 */
    function syncThumbWindow() {
        for (let i = 0; i < images.length; i += 1) {
            if (Math.abs(i - index) <= THUMB_WINDOW) ensureThumb(i);
            else clearThumb(i);
        }
    }

    /** 横向滚动时，把进入视口的缩略图补上。 */
    let thumbObserver = null;
    if (typeof IntersectionObserver === 'function') {
        thumbObserver = new IntersectionObserver((entries) => {
            if (closed) return;
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const i = thumbs.indexOf(entry.target);
                if (i >= 0) ensureThumb(i);
            }
        }, { root: strip, rootMargin: '200px' });
        for (const thumb of thumbs) thumbObserver.observe(thumb);
    }
    let prepareSequence = 0;
    let preparedDownload = null;
    let down = null;
    let taps = [];
    function revokePrepared(delayed = false) {
        const old = preparedDownload;
        preparedDownload = null;
        if (old?.owned) {
            if (delayed || old.used) setTimeout(() => URL.revokeObjectURL(old.url), 60000);
            else URL.revokeObjectURL(old.url);
        }
    }
    async function prepareDownload(item) {
        const sequence = ++prepareSequence;
        revokePrepared();
        try {
            let blob = item.blob;
            if (!(blob instanceof Blob) && item.imageRef && typeof opts?.getImageBlob === 'function') blob = await opts.getImageBlob(item.imageRef);
            if (!(blob instanceof Blob)) {
                if (!item.url) throw new Error('读取图片失败');
                const response = await fetch(item.url);
                if (!response.ok) throw new Error('读取图片失败');
                blob = await response.blob();
            }
            const detected = await detectImageMime(blob);
            const extension = imageExtension(detected, item.url);
            if (!extension) throw new Error('无法确定图片格式');
            if (closed || sequence !== prepareSequence) return;
            const url = URL.createObjectURL(blob);
            const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
            preparedDownload = { url, mime, owned: true };
        } catch {
            if (!closed && sequence === prepareSequence) preparedDownload = null;
        }
    }
    function activateThumbnail() {
        const thumb = thumbs[index];
        if (!thumb || !strip.isConnected) return;
        if (index === thumbs.length - 1) { strip.scrollLeft = strip.scrollWidth; return; }
        const visible = strip.getBoundingClientRect();
        const selected = thumb.getBoundingClientRect();
        if (selected.left < visible.left) strip.scrollLeft += selected.left - visible.left;
        else if (selected.right > visible.right) strip.scrollLeft += selected.right - visible.right;
    }
    function select(value, notify = true) {
        return selectAsync(value, notify);
    }

    /**
     * 切换当前图：先更新 UI，再按需解析 URL，避免打开时把 500 张全部解析。
     * @param {number} value
     * @param {boolean} [notify]
     */
    async function selectAsync(value, notify = true) {
        const previousIndex = index;
        index = Math.max(0, Math.min(images.length - 1, value));
        const sequence = ++selectSequence;
        const item = images[index];
        img.alt = String(item?.alt || opts?.alt || `图片 ${index + 1}`);
        count.textContent = `${index + 1} / ${images.length}`;
        previous.disabled = index === 0;
        next.disabled = index === images.length - 1;
        thumbs.forEach((thumb, i) => {
            thumb.classList.toggle('is-active', i === index);
            thumb.setAttribute('aria-current', i === index ? 'true' : 'false');
        });
        activateThumbnail();
        syncThumbWindow();
        void prepareDownload(item);
        if (notify && index !== previousIndex && typeof opts?.onSelect === 'function') {
            Promise.resolve(opts.onSelect(item, item?.sourceIndex)).catch(() => {
                error.textContent = '无法更新外部预览'; error.hidden = false;
            });
        }
        const url = await resolveAt(index);
        if (closed || sequence !== selectSequence) return;
        if (!url) {
            if (typeof img.removeAttribute === 'function') img.removeAttribute('src');
            error.textContent = '图片缓存已清理或不可用';
            error.hidden = false;
            return;
        }
        img.src = url;
        error.hidden = true;
    }
    img.addEventListener('pointerdown', (event) => {
        if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) { down = null; taps = []; return; }
        down = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now() };
    });
    img.addEventListener('pointermove', (event) => {
        if (down && (Math.abs(event.clientX - down.x) > 10 || Math.abs(event.clientY - down.y) > 10)) { down = null; taps = []; }
    });
    img.addEventListener('pointercancel', () => { down = null; taps = []; });
    img.addEventListener('pointerup', (event) => {
        const now = Date.now();
        if (!down || down.id !== event.pointerId || now - down.time > 350 || Math.abs(event.clientX-down.x) > 10 || Math.abs(event.clientY-down.y) > 10) { down = null; taps = []; return; }
        down = null;
        if (taps.length && now - taps[taps.length-1] > 350) taps = [];
        taps.push(now);
        if (taps.length < 3) return;
        const within = now - taps[0] <= 800; taps = [];
        if (!within) return;
        if (!preparedDownload) { error.textContent = '图片尚未准备好下载或无法读取，请稍后重试'; error.hidden = false; return; }
        try { requestImageDownload(preparedDownload.url, preparedDownload.mime); preparedDownload.used = true; }
        catch (cause) { error.textContent = cause?.message || '无法请求下载'; error.hidden = false; }
    });
    toolbar.append(previous, count, next, closeButton);
    overlay.append(toolbar, strip, img, error);
    await select(index, false);

    function close() {
        if (closed) return;
        closed = true;
        prepareSequence += 1;
        selectSequence += 1;
        revokePrepared(true);
        try {
            if (thumbObserver) thumbObserver.disconnect();
        } catch {
            // ignore
        }
        for (let i = 0; i < thumbPreviews.length; i += 1) clearThumb(i);
        for (const url of ownedSourceUrls) URL.revokeObjectURL(url);
        document.removeEventListener('keydown', onKey, true);
        try {
            if (overlay.open && typeof overlay.close === 'function') overlay.close();
        } catch { /* ignore */ }
        overlay.remove();
    }
    /** @param {KeyboardEvent} event */
    function onKey(event) {
        if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') close();
        else select(index + (event.key === 'ArrowLeft' ? -1 : 1));
    }
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });
    overlay.addEventListener('close', close);
    document.addEventListener('keydown', onKey, true);
    const parent = document.body || document.documentElement;
    parent.appendChild(overlay);
    if (typeof overlay.showModal === 'function') {
        overlay.showModal();
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { if (!closed) activateThumbnail(); });
    else activateThumbnail();
    return { destroy: close };
}
