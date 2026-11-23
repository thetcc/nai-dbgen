/**
 * L4 应用层 · 图片缓存裁剪（需求 4.17）。
 * 默认（启动自动裁剪）：读常规设置上限 → imageRepo.trimToLimit → 通知 UI。
 * 手动清理传 { clearAll: true }：忽略上限清空可清理图片，pinned 与画师图库仍保留。
 */

import { Ok, isErr } from '../infra/result.js';
import { APP_EVENTS } from './_helpers.js';

/** 与 defaultPluginSettings().imageCacheLimit 一致 */
const DEFAULT_IMAGE_CACHE_LIMIT = 500;

/**
 * @typedef {object} ImageCacheTrimResult
 * @property {number} removed
 * @property {string[]} removedRefs
 * @property {number} limit
 */

/**
 * @param {object} deps
 * @param {() => { imageCacheLimit?: number }} deps.loadSettings
 * @param {{ trimToLimit: (limit: number, opts?: { clearAll?: boolean }) => Promise<import('../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>> }} deps.imageRepo
 * @param {{ emit: (type: string, payload?: unknown) => void }} [deps.bus]
 * @returns {{ trim: (opts?: { clearAll?: boolean }) => Promise<import('../infra/result.js').Ok<ImageCacheTrimResult>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>> }}
 */
export function createImageCacheTrimService(deps) {
    const loadSettings = deps?.loadSettings;
    const imageRepo = deps?.imageRepo;
    const bus = deps?.bus;
    if (typeof loadSettings !== 'function') {
        throw new Error('createImageCacheTrimService requires loadSettings');
    }
    if (!imageRepo || typeof imageRepo.trimToLimit !== 'function') {
        throw new Error('createImageCacheTrimService requires imageRepo.trimToLimit');
    }

    return {
        async trim(opts) {
            const clearAll = opts?.clearAll === true;
            let limit = clearAll ? 0 : DEFAULT_IMAGE_CACHE_LIMIT;
            if (!clearAll) {
                try {
                    const settings = loadSettings();
                    const raw = settings?.imageCacheLimit;
                    if (Number.isInteger(raw) && raw >= 1) {
                        limit = raw;
                    }
                } catch {
                    // 读设置失败时用默认上限继续裁剪
                }
            }

            const r = clearAll
                ? await imageRepo.trimToLimit(limit, { clearAll: true })
                : await imageRepo.trimToLimit(limit);
            if (isErr(r)) {
                return r;
            }

            const { removed, removedRefs } = r.value;
            if (removed > 0 && bus && typeof bus.emit === 'function') {
                bus.emit(APP_EVENTS.IMAGE_CACHE_TRIMMED, {
                    removed,
                    removedRefs: [...removedRefs],
                    limit,
                });
            }

            return Ok({
                removed,
                removedRefs: [...removedRefs],
                limit,
            });
        },
    };
}
