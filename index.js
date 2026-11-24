/* 文字抽取成图 (Cutout Poster) - SillyTavern 扩展
 * 框架：划词按钮 -> 面板 -> 模板渲染(Canvas) -> 导出 PNG
 * 新增模板：CutoutPoster.register({ id, name, controls, defaults, hint, render, ... })
 */
(() => {
    'use strict';

    const EXT = 'cutout_poster';
    const SAMPLE = 'A kaleidoscope of painted wings dances across the vast and tranquil cerulean sky.';

    /* ---------- 基础工具 ---------- */
    const getCtx = () => (window.SillyTavern && SillyTavern.getContext ? SillyTavern.getContext() : null);
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function toast(msg) {
        if (window.toastr) window.toastr.info(msg); else alert(msg);
    }

    /* ---------- 设置存取 ---------- */
    let fallbackSettings = null;
    function getSettings() {
        const c = getCtx();
        let s;
        if (c && c.extensionSettings) {
            c.extensionSettings[EXT] ??= {};
            s = c.extensionSettings[EXT];
        } else {
            fallbackSettings ??= JSON.parse(localStorage.getItem(EXT) || '{}');
            s = fallbackSettings;
        }
        s.template ??= 'cutout';
        s.params ??= {};
        return s;
    }
    function saveSettings() {
        const c = getCtx();
        if (c && c.saveSettingsDebounced) c.saveSettingsDebounced();
        else localStorage.setItem(EXT, JSON.stringify(fallbackSettings));
    }

    /* ---------- 文字处理 ---------- */
    const TOKEN_RE = /\{\s*\}|[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]|[^\s\u3400-\u9fff\u3000-\u303f\uff00-\uffef{]+|\{/g;
    function tokenize(text) {
        const out = [];
        let m;
        TOKEN_RE.lastIndex = 0;
        while ((m = TOKEN_RE.exec(text))) {
            const t = m[0];
            const nxt = text[m.index + t.length];
            out.push({ t, slot: /^\{\s*\}$/.test(t), sp: !!nxt && /\s/.test(nxt) });
        }
        return out;
    }
    function wrap(items, maxW) {
        const lines = [];
        let cur = [], w = 0;
        for (const it of items) {
            if (cur.length && w + it.w > maxW + 1) { lines.push({ items: cur, w }); cur = []; w = 0; }
            cur.push(it); w += it.w;
        }
        if (cur.length) lines.push({ items: cur, w });
        return lines;
    }
    const measureCv = document.createElement('canvas');
    const mctx = measureCv.getContext('2d');

    /* ---------- 图形路径 ---------- */
    function pathShape(c, shape, cx, cy, w, h) {
        const x = cx - w / 2, y = cy - h / 2;
        c.beginPath();
        switch (shape) {
            case 'circle':
            case 'ellipse':
                c.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); break;
            case 'diamond':
                c.moveTo(cx, y); c.lineTo(x + w, cy); c.lineTo(cx, y + h); c.lineTo(x, cy); c.closePath(); break;
            case 'triangle':
                c.moveTo(cx, y); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath(); break;
            case 'star': {
                const R = w / 2, r = R * 0.45;
                for (let i = 0; i < 10; i++) {
                    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R;
                    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * (h / w);
                    i ? c.lineTo(px, py) : c.moveTo(px, py);
                }
                c.closePath(); break;
            }
            case 'heart':
                c.moveTo(cx, y + h * 0.95);
                c.bezierCurveTo(x - w * 0.1, y + h * 0.55, x + w * 0.05, y - h * 0.05, cx, y + h * 0.28);
                c.bezierCurveTo(x + w * 0.95, y - h * 0.05, x + w * 1.1, y + h * 0.55, cx, y + h * 0.95);
                c.closePath(); break;
            default:
                c.rect(x, y, w, h);
        }
    }

    /* ---------- 运行时状态 ---------- */
    const S = {
        text: '',
        img: null,
        imgId: 0,
        seed: 1,
        hits: [],       // 当前画面上可点击的区域
        geo: null,
        cut: null,      // 挖洞模板的洞
        keep: null,     // 涂黑诗保留的词
        cells: null,    // 验证码选中的格子
        drag: null,
        ctls: {},
    };
    const TEMPLATES = {};

    function makePlaceholder() {
        const cv = document.createElement('canvas');
        cv.width = 1200; cv.height = 800;
        const c = cv.getContext('2d');
        const g = c.createLinearGradient(0, 0, 1200, 800);
        g.addColorStop(0, '#6ea8e8'); g.addColorStop(1, '#2d6a4f');
        c.fillStyle = g; c.fillRect(0, 0, 1200, 800);
        const rng = mulberry32(42);
        for (let i = 0; i < 90; i++) {
            c.fillStyle = `hsl(${Math.floor(rng() * 360)},75%,60%)`;
            c.beginPath();
            c.ellipse(rng() * 1200, rng() * 800, 10 + rng() * 26, 6 + rng() * 14, rng() * 3, 0, Math.PI * 2);
            c.fill();
        }
        return cv;
    }
    function imgW(img) { return img.naturalWidth || img.width; }
    function imgH(img) { return img.naturalHeight || img.height; }

    /* =====================================================
     * 模板 1：挖洞置换
     * ===================================================== */
    function holeH(P, wpx) {
        return (P.shape === 'rect' || P.shape === 'ellipse') ? wpx / Math.max(0.2, P.aspect) : wpx;
    }
    function overlap(a, b, IW, IH) {
        return Math.abs(a.cx - b.cx) * IW < (a.w + b.w) * IW / 2 + 6 &&
               Math.abs(a.cy - b.cy) * IH < (a.h + b.h) * IH / 2 + 6;
    }
    function genHoles(P) {
        const img = S.img, IW = 1200, IH = IW * imgH(img) / imgW(img);
        const rng = mulberry32(S.seed);
        const holes = [];
        for (let i = 0; i < P.count; i++) {
            for (let t = 0; t < 40; t++) {
                const wpx = IW * lerp(P.sizeMin, P.sizeMax, rng()) / 100;
                const hpx = holeH(P, wpx);
                const cx = (wpx / 2 + rng() * Math.max(0, IW - wpx)) / IW;
                const cy = (hpx / 2 + rng() * Math.max(0, IH - hpx)) / IH;
                const cand = { cx, cy, w: wpx / IW, h: hpx / IH, ox: 0, oy: 0 };
                if (t === 39 || !holes.some(o => overlap(o, cand, IW, IH))) { holes.push(cand); break; }
            }
        }
        return holes;
    }
    function ensureCut(P) {
        const sig = [S.seed, S.imgId, P.count, P.sizeMin, P.sizeMax, P.shape, P.aspect].join('|');
        if (!S.cut || (P.mode === 'random' && S.cut.sig !== sig)) {
            S.cut = { holes: genHoles(P), sig: P.mode === 'manual' ? 'manual' : sig };
        }
    }
    function autoSlots(toks, n, seed) {
        const rng = mulberry32(seed + 7);
        const out = [];
        if (!toks.length) { for (let i = 0; i < n; i++) out.push({ t: '{ }', slot: true, sp: true }); return out; }
        const pick = new Set();
        const max = Math.min(n, toks.length);
        while (pick.size < max) pick.add(Math.floor(rng() * toks.length));
        toks.forEach((t, i) => { out.push(t); if (pick.has(i)) out.push({ t: '{ }', slot: true, sp: true }); });
        return out;
    }
    function drawFrag(c, P, hole, IW, IH, dcx, dcy, dw, dh) {
        const img = S.img;
        const sx = (hole.cx - hole.w / 2) * imgW(img), sy = (hole.cy - hole.h / 2) * imgH(img);
        const sw = hole.w * imgW(img), sh = hole.h * imgH(img);
        c.save();
        pathShape(c, P.shape, dcx, dcy, dw, dh);
        c.clip();
        c.drawImage(img, sx, sy, sw, sh, dcx - dw / 2, dcy - dh / 2, dw, dh);
        c.restore();
        if (P.border) {
            pathShape(c, P.shape, dcx, dcy, dw, dh);
            c.lineWidth = 2; c.strokeStyle = P.fg; c.stroke();
        }
    }

    const cutout = {
        id: 'cutout',
        name: '挖洞置换',
        hint: '手动模式：点图片挖洞/再点取消；"下方散落"布局可拖动碎片。文字里写 { } 可指定槽位。',
        defaults: {
            layout: 'below', shape: 'square', mode: 'random', count: 8,
            sizeMin: 5, sizeMax: 9, aspect: 1.5, lowerPct: 100,
            bg: '#f1efe6', fg: '#222222', border: false, fontSize: 3.4, font: 'sans',
        },
        controls: [
            { key: 'layout', label: '碎片落点', type: 'select', options: [['below', '下方散落'], ['slots', '文字 { } 槽位']] },
            { key: 'shape', label: '洞的形状', type: 'select', options: [['square', '方形'], ['circle', '圆形'], ['rect', '长方形'], ['ellipse', '椭圆'], ['diamond', '菱形'], ['triangle', '三角'], ['star', '星形'], ['heart', '爱心']] },
            { key: 'mode', label: '洞的位置', type: 'select', options: [['random', '随机'], ['manual', '手动点选']] },
            { key: 'count', label: '数量', type: 'range', min: 1, max: 40, step: 1, show: P => P.mode === 'random' },
            { key: 'sizeMin', label: '最小尺寸 %', type: 'range', min: 2, max: 40, step: 1 },
            { key: 'sizeMax', label: '最大尺寸 %', type: 'range', min: 2, max: 40, step: 1 },
            { key: 'aspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1 },
            { key: 'lowerPct', label: '下方区域高度 %', type: 'range', min: 40, max: 160, step: 5, show: P => P.layout === 'below' },
            { key: 'fontSize', label: '文字大小', type: 'range', min: 1.5, max: 6, step: 0.1, show: P => P.layout === 'slots' },
            { key: 'font', label: '字体', type: 'select', options: FONT_OPTS(), show: P => P.layout === 'slots' },
            { key: 'bg', label: '底色/洞色', type: 'color' },
            { key: 'fg', label: '文字/描边色', type: 'color' },
            { key: 'border', label: '碎片描边', type: 'checkbox' },
        ],
        clear(P) { S.cut = { holes: [], sig: 'manual' }; return { mode: 'manual' }; },
        reset(P) { S.cut = null; },
        render(cv, c, P) {
            ensureCut(P);
            const img = S.img, holes = S.cut.holes;
            const W = 1200, IW = W, IH = Math.round(W * imgH(img) / imgW(img));
            if (P.layout === 'slots') return renderSlots(cv, c, P, W, IW, IH, holes);
            const lowerH = Math.round(IH * P.lowerPct / 100);
            cv.width = W; cv.height = IH + lowerH;
            c.fillStyle = P.bg; c.fillRect(0, 0, cv.width, cv.height);
            c.drawImage(img, 0, 0, IW, IH);
            S.geo = { x: 0, y: 0, w: IW, h: IH };
            holes.forEach(h => {
                pathShape(c, P.shape, h.cx * IW, h.cy * IH, h.w * IW, h.h * IH);
                c.fillStyle = P.bg; c.fill();
            });
            holes.forEach((h, i) => {
                const dw = h.w * IW, dh = h.h * IH;
                const dx = h.cx * IW + (h.ox || 0), dy = IH + h.cy * lowerH + (h.oy || 0);
                drawFrag(c, P, h, IW, IH, dx, dy, dw, dh);
                S.hits.push({ kind: 'frag', i, x: dx - dw / 2, y: dy - dh / 2, w: dw, h: dh });
            });
        },
        onDown(x, y, P, ui) {
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if (h.kind === 'frag' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
                    const ho = S.cut.holes[h.i];
                    S.drag = { i: h.i, sx: x, sy: y, ox: ho.ox || 0, oy: ho.oy || 0 };
                    return true;
                }
            }
            const g = S.geo;
            if (!g || x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return false;
            if (P.mode !== 'manual') { ui.setParam('mode', 'manual'); }
            const fx = (x - g.x) / g.w, fy = (y - g.y) / g.h;
            const holes = S.cut.holes;
            const hit = holes.findIndex(h => Math.abs(fx - h.cx) <= h.w / 2 && Math.abs(fy - h.cy) <= h.h / 2);
            if (hit >= 0) holes.splice(hit, 1);
            else {
                const wpx = g.w * (P.sizeMin + P.sizeMax) / 200;
                const hpx = holeH(P, wpx);
                holes.push({ cx: fx, cy: fy, w: wpx / g.w, h: hpx / g.h, ox: 0, oy: 0 });
            }
            S.cut.sig = 'manual';
            return true;
        },
        onMove(x, y) {
            if (!S.drag) return false;
            const ho = S.cut.holes[S.drag.i];
            ho.ox = S.drag.ox + (x - S.drag.sx);
            ho.oy = S.drag.oy + (y - S.drag.sy);
            return true;
        },
        onUp() { S.drag = null; },
    };

    function renderSlots(cv, c, P, W, IW, IH, holes) {
        const fs = Math.round(W * P.fontSize / 100);
        const fam = fontFamily(P.font);
        mctx.font = `${fs}px ${fam}`;
        let toks = tokenize((S.text || '').trim() || SAMPLE);
        if (!toks.some(t => t.slot)) toks = autoSlots(toks, holes.length, S.seed);
        const spaceW = mctx.measureText(' ').width;
        const braceW = mctx.measureText('{').width;
        let slotI = 0;
        const items = toks.map(tk => {
            if (tk.slot) {
                const i = slotI++, h = holes[i];
                let fh = fs * 2.4, fw = h ? fh * (h.w * IW) / (h.h * IH) : fh * 1.4;
                const cap = W * 0.28;
                if (fw > cap) { fw = cap; fh = h ? fw * (h.h * IH) / (h.w * IW) : fw / 1.4; }
                return { slot: true, i, fw, fh, w: braceW * 2 + fw + fs * 0.5 + spaceW };
            }
            return { t: tk.t, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) };
        });
        const lines = wrap(items, W * 0.84);
        lines.forEach(l => {
            const mf = Math.max(0, ...l.items.filter(i => i.slot).map(i => i.fh));
            l.lh = Math.max(fs * 1.9, mf ? mf + fs * 0.6 : 0);
        });
        const pad = fs * 3;
        const textH = Math.round(pad * 2 + lines.reduce((s, l) => s + l.lh, 0));
        cv.width = W; cv.height = textH + IH;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, cv.height);
        c.drawImage(S.img, 0, textH, IW, IH);
        S.geo = { x: 0, y: textH, w: IW, h: IH };
        holes.forEach(h => {
            pathShape(c, P.shape, h.cx * IW, textH + h.cy * IH, h.w * IW, h.h * IH);
            c.fillStyle = P.bg; c.fill();
        });
        c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'left';
        let y = pad;
        lines.forEach(l => {
            let x = (W - l.w) / 2;
            const cy = y + l.lh / 2;
            l.items.forEach(it => {
                if (it.slot) {
                    c.fillStyle = P.fg;
                    c.fillText('{', x, cy);
                    const fx = x + braceW + fs * 0.25;
                    const h = holes[it.i];
                    if (h) drawFrag(c, P, h, IW, IH, fx + it.fw / 2, cy, it.fw, it.fh);
                    else {
                        c.save(); c.setLineDash([6, 5]); c.strokeStyle = P.fg;
                        c.strokeRect(fx, cy - it.fh / 2, it.fw, it.fh); c.restore();
                    }
                    c.fillStyle = P.fg;
                    c.fillText('}', fx + it.fw + fs * 0.25, cy);
                } else {
                    c.fillStyle = P.fg; c.fillText(it.t, x, cy);
                }
                x += it.w;
            });
            y += l.lh;
        });
    }

    /* =====================================================
     * 模板 2：涂黑诗
     * ===================================================== */
    function ensureKeep(P, toks) {
        const sig = [S.seed, (S.text || ''), P.keepPct].join('|');
        if (!S.keep || (P.mode === 'random' && S.keep.sig !== sig)) {
            const rng = mulberry32(S.seed * 31 + 5);
            const idx = toks.map((_, i) => i);
            for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
            const n = Math.max(1, Math.round(toks.length * P.keepPct / 100));
            S.keep = { set: new Set(idx.slice(0, n)), sig: P.mode === 'manual' ? 'manual' : sig };
        }
    }
    const blackout = {
        id: 'blackout',
        name: '涂黑诗',
        hint: '手动模式：点词语切换"保留/涂黑"。',
        defaults: { mode: 'random', keepPct: 18, fontSize: 3.2, font: 'serif', paper: '#f4efdc', ink: '#111111' },
        controls: [
            { key: 'mode', label: '保留的词', type: 'select', options: [['random', '随机'], ['manual', '手动点选']] },
            { key: 'keepPct', label: '保留比例 %', type: 'range', min: 3, max: 70, step: 1, show: P => P.mode === 'random' },
            { key: 'fontSize', label: '文字大小', type: 'range', min: 1.8, max: 6, step: 0.1 },
            { key: 'font', label: '字体', type: 'select', options: FONT_OPTS() },
            { key: 'paper', label: '纸色', type: 'color' },
            { key: 'ink', label: '墨色', type: 'color' },
        ],
        clear() { S.keep = { set: new Set(), sig: 'manual' }; return { mode: 'manual' }; },
        reset() { S.keep = null; },
        render(cv, c, P) {
            const W = 1000, M = 90;
            const fs = Math.round(W * P.fontSize / 100);
            const fam = fontFamily(P.font);
            mctx.font = `${fs}px ${fam}`;
            const toks = tokenize((S.text || '').trim() || SAMPLE);
            ensureKeep(P, toks);
            const spaceW = mctx.measureText(' ').width;
            const items = toks.map((tk, i) => ({ i, t: tk.t, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) }));
            const lines = wrap(items, W - M * 2);
            const lh = fs * 1.7;
            cv.width = W; cv.height = Math.round(M * 2 + lines.length * lh);
            c.fillStyle = P.paper; c.fillRect(0, 0, W, cv.height);
            c.font = `${fs}px ${fam}`; c.textBaseline = 'middle';
            let y = M;
            for (const l of lines) {
                let x = M;
                for (const it of l.items) {
                    const kept = S.keep.set.has(it.i);
                    if (kept) {
                        c.fillStyle = P.ink; c.fillRect(x - 3, y + 2, it.w + 3, lh - 4);
                        c.fillStyle = P.paper; c.fillRect(x, y + lh * 0.12, it.w - 3, lh * 0.76);
                        c.fillStyle = P.ink; c.fillText(it.t, x + 2, y + lh / 2);
                    } else {
                        c.fillStyle = P.ink; c.fillRect(x - 2, y + 2, it.w + 3, lh - 4);
                    }
                    S.hits.push({ kind: 'tok', i: it.i, x, y, w: it.w, h: lh });
                    x += it.w;
                }
                y += lh;
            }
        },
        onDown(x, y, P, ui) {
            const h = S.hits.find(h => h.kind === 'tok' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
            if (!h) return false;
            if (P.mode !== 'manual') ui.setParam('mode', 'manual');
            S.keep.set.has(h.i) ? S.keep.set.delete(h.i) : S.keep.set.add(h.i);
            S.keep.sig = 'manual';
            return true;
        },
    };

    /* =====================================================
     * 模板 3：验证码九宫格
     * ===================================================== */
    function ensureCells(P) {
        const sig = [S.seed, P.cols, P.rows, P.selectPct].join('|');
        if (!S.cells || (P.mode === 'random' && S.cells.sig !== sig)) {
            const total = P.cols * P.rows;
            const rng = mulberry32(S.seed * 17 + 3);
            const idx = Array.from({ length: total }, (_, i) => i);
            for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
            S.cells = { set: new Set(idx.slice(0, Math.round(total * P.selectPct / 100))), sig: P.mode === 'manual' ? 'manual' : sig };
        }
    }
    const captcha = {
        id: 'captcha',
        name: '验证码九宫格',
        hint: '手动模式：点格子选中/取消。标题留空则取选中文字。',
        defaults: { mode: 'random', cols: 4, rows: 4, selectPct: 30, gap: 8, title: '', sub: 'If there are none, click skip', blue: '#2f77e8' },
        controls: [
            { key: 'title', label: '大标题(留空=选中文字)', type: 'text' },
            { key: 'sub', label: '副标题', type: 'text' },
            { key: 'cols', label: '列数', type: 'range', min: 2, max: 8, step: 1 },
            { key: 'rows', label: '行数', type: 'range', min: 2, max: 8, step: 1 },
            { key: 'mode', label: '选中的格子', type: 'select', options: [['random', '随机'], ['manual', '手动点选']] },
            { key: 'selectPct', label: '选中比例 %', type: 'range', min: 0, max: 100, step: 5, show: P => P.mode === 'random' },
            { key: 'gap', label: '格间距', type: 'range', min: 0, max: 20, step: 1 },
            { key: 'blue', label: '主色', type: 'color' },
        ],
        clear() { S.cells = { set: new Set(), sig: 'manual' }; return { mode: 'manual' }; },
        reset() { S.cells = null; },
        render(cv, c, P) {
            ensureCells(P);
            const img = S.img, W = 1000, pad = 40, gap = P.gap, cols = P.cols, rows = P.rows;
            const gw = W - pad * 2, cw = (gw - gap * (cols - 1)) / cols, gh = rows * cw + gap * (rows - 1);
            const headH = 280, footH = 170, y0 = pad + headH + gap, footY = y0 + gh + gap;
            cv.width = W; cv.height = Math.round(footY + footH);
            c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, W, cv.height);
            // 标题
            c.fillStyle = P.blue; c.fillRect(pad, pad, gw, headH);
            c.fillStyle = '#fff'; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
            c.font = '34px Roboto, Arial, sans-serif';
            c.fillText('Select all squares with', pad + 30, pad + 70);
            const title = ((P.title || S.text || 'a human').trim().replace(/\s+/g, ' ')).slice(0, 40);
            let tfs = 100;
            do { c.font = `bold ${tfs}px Roboto, Arial, sans-serif`; tfs -= 4; } while (c.measureText(title).width > gw - 60 && tfs > 24);
            c.fillText(title, pad + 30, pad + 170);
            c.font = '32px Roboto, Arial, sans-serif';
            c.fillText(P.sub, pad + 30, pad + 232);
            // 图片按 cover 裁成网格区域
            const s = Math.max(gw / imgW(img), gh / imgH(img));
            const sx0 = (imgW(img) - gw / s) / 2, sy0 = (imgH(img) - gh / s) / 2;
            for (let r = 0; r < rows; r++) {
                for (let k = 0; k < cols; k++) {
                    const dx = pad + k * (cw + gap), dy = y0 + r * (cw + gap), idx = r * cols + k;
                    const sel = S.cells.set.has(idx);
                    const sc = sel ? 0.84 : 1, dw = cw * sc, off = (cw - dw) / 2;
                    c.drawImage(img, sx0 + (dx - pad) / s, sy0 + (dy - y0) / s, cw / s, cw / s, dx + off, dy + off, dw, dw);
                    if (sel) {
                        const bx = dx + 6, by = dy + 6;
                        c.fillStyle = P.blue; c.beginPath(); c.arc(bx + 20, by + 20, 22, 0, Math.PI * 2); c.fill();
                        c.strokeStyle = '#fff'; c.lineWidth = 5; c.lineCap = 'round'; c.lineJoin = 'round';
                        c.beginPath(); c.moveTo(bx + 10, by + 21); c.lineTo(bx + 18, by + 29); c.lineTo(bx + 31, by + 12); c.stroke();
                    }
                    S.hits.push({ kind: 'cell', i: idx, x: dx, y: dy, w: cw, h: cw });
                }
            }
            S.geo = null;
            // 底部图标与按钮
            const cy = footY + footH / 2 + 4;
            c.strokeStyle = '#666'; c.lineWidth = 7; c.lineCap = 'round';
            c.beginPath(); c.arc(pad + 55, cy, 26, 0.5, Math.PI * 1.75); c.stroke();
            c.beginPath(); c.moveTo(pad + 80, cy - 36); c.lineTo(pad + 80, cy - 14); c.lineTo(pad + 62, cy - 14); c.closePath(); c.fillStyle = '#666'; c.fill();
            const hx = pad + 160;
            c.beginPath(); c.arc(hx, cy + 4, 28, Math.PI, 0); c.stroke();
            c.fillRect(hx - 36, cy + 2, 14, 30); c.fillRect(hx + 22, cy + 2, 14, 30);
            const ix = pad + 270;
            c.beginPath(); c.arc(ix, cy, 32, 0, Math.PI * 2); c.stroke();
            c.fillStyle = '#666'; c.font = 'bold 40px Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
            c.fillText('i', ix, cy + 2);
            const bw = 280, bh = 100, bx = W - pad - bw, by = footY + (footH - bh) / 2;
            c.fillStyle = P.blue; c.fillRect(bx, by, bw, bh);
            c.fillStyle = '#fff'; c.font = 'bold 40px Roboto, Arial, sans-serif';
            c.fillText(S.cells.set.size ? 'VERIFY' : 'SKIP', bx + bw / 2, by + bh / 2 + 2);
            c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        },
        onDown(x, y, P, ui) {
            const h = S.hits.find(h => h.kind === 'cell' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
            if (!h) return false;
            if (P.mode !== 'manual') ui.setParam('mode', 'manual');
            S.cells.set.has(h.i) ? S.cells.set.delete(h.i) : S.cells.set.add(h.i);
            S.cells.sig = 'manual';
            return true;
        },
    };

    /* ---------- 字体 ---------- */
    function FONT_OPTS() { return [['sans', '无衬线'], ['serif', '衬线'], ['mono', '等宽'], ['kai', '楷体/手写']]; }
    function fontFamily(k) {
        return ({
            sans: 'Inter, "PingFang SC", "Microsoft YaHei", Arial, sans-serif',
            serif: '"Playfair Display", "Songti SC", SimSun, Georgia, serif',
            mono: '"Courier New", Menlo, monospace',
            kai: 'KaiTi, "Kaiti SC", STKaiti, cursive, serif',
        })[k] || 'sans-serif';
    }

    /* ---------- 模板注册 ---------- */
    function register(t) { TEMPLATES[t.id] = t; }
    [cutout, blackout, captcha].forEach(register);
    window.CutoutPoster = { register, templates: TEMPLATES };

    /* =====================================================
     * 图片加载
     * ===================================================== */
    async function loadImage(src) {
        let url = src;
        try {
            if (!/^(blob:|data:)/.test(src)) {
                const r = await fetch(src);
                if (r.ok) url = URL.createObjectURL(await r.blob());
            }
        } catch (e) { /* 回退到直接加载 */ }
        return new Promise((res, rej) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => res(im);
            im.onerror = () => rej(new Error('图片加载失败'));
            im.src = url;
        });
    }
    function setImage(im) {
        S.img = im; S.imgId++; S.cut = null;
    }

    /* =====================================================
     * 面板
     * ===================================================== */
    let overlay = null, cv = null, c2d = null, rafPending = false;
    const $ = sel => overlay.querySelector(sel);

    function params() {
        const st = getSettings(), tpl = TEMPLATES[st.template];
        st.params[tpl.id] = Object.assign({}, tpl.defaults, st.params[tpl.id]);
        return st.params[tpl.id];
    }
    function scheduleRender() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; render(); });
    }
    function render() {
        if (!overlay) return;
        const tpl = TEMPLATES[getSettings().template], P = params();
        if (!S.img) setImage(makePlaceholder());
        S.hits = [];
        try { tpl.render(cv, c2d, P); }
        catch (e) { console.error('[CutoutPoster] render error', e); toast('渲染出错，详见控制台'); }
        $('#cp_hint').textContent = tpl.hint || '';
        updateVisibility();
    }
    const ui = {
        setParam(key, val) {
            const P = params(); P[key] = val; saveSettings();
            const el = S.ctls[key];
            if (el) { if (el.type === 'checkbox') el.checked = val; else el.value = val; }
        },
    };
    function updateVisibility() {
        const tpl = TEMPLATES[getSettings().template], P = params();
        tpl.controls.forEach(ct => {
            const el = S.ctls[ct.key];
            if (el && el.parentElement) el.parentElement.style.display = (ct.show && !ct.show(P)) ? 'none' : '';
        });
    }
    function buildControls() {
        const tpl = TEMPLATES[getSettings().template], P = params(), box = $('#cp_dyn');
        box.innerHTML = ''; S.ctls = {};
        tpl.controls.forEach(ct => {
            const wrap = document.createElement('label');
            wrap.className = 'cp_ctl' + (ct.type === 'checkbox' ? ' cp_inline' : '');
            const span = document.createElement('span');
            span.textContent = ct.label;
            let input;
            if (ct.type === 'select') {
                input = document.createElement('select');
                ct.options.forEach(([v, l]) => input.add(new Option(l, v)));
                input.value = P[ct.key];
            } else if (ct.type === 'range') {
                input = document.createElement('input');
                input.type = 'range'; input.min = ct.min; input.max = ct.max; input.step = ct.step; input.value = P[ct.key];
                const out = document.createElement('b'); out.textContent = ' ' + P[ct.key];
                span.append(out);
                input.addEventListener('input', () => { out.textContent = ' ' + input.value; });
            } else if (ct.type === 'checkbox') {
                input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!P[ct.key];
            } else {
                input = document.createElement('input'); input.type = ct.type === 'color' ? 'color' : 'text'; input.value = P[ct.key];
            }
            input.addEventListener('input', () => {
                const v = ct.type === 'range' ? Number(input.value) : ct.type === 'checkbox' ? input.checked : input.value;
                params()[ct.key] = v; saveSettings(); scheduleRender();
            });
            S.ctls[ct.key] = input;
            wrap.append(span, input);
            box.append(wrap);
        });
        updateVisibility();
    }

    function canvasXY(e) {
        const r = cv.getBoundingClientRect();
        const k = Math.min(r.width / cv.width, r.height / cv.height);
        const w = cv.width * k, h = cv.height * k;
        const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
        return [(e.clientX - ox) / k, (e.clientY - oy) / k];
    }

    function buildPanel() {
        overlay = document.createElement('div');
        overlay.id = 'cp_overlay';
        overlay.innerHTML = `
        <div id="cp_panel">
          <div class="cp_head"><b>✂ 文字抽取成图</b><span id="cp_close">✕</span></div>
          <div class="cp_body">
            <div class="cp_preview"><div class="cp_stage"><canvas id="cp_canvas"></canvas></div><div id="cp_hint"></div></div>
            <div class="cp_side">
              <label class="cp_blk"><span>模板</span><select id="cp_tpl"></select></label>
              <label class="cp_blk"><span>文字（可直接编辑）</span><textarea id="cp_text" rows="4" placeholder="${SAMPLE}"></textarea></label>
              <div class="cp_blk"><span style="font-size:13px">图片</span>
                <div class="cp_row">
                  <button id="cp_upload" class="menu_button">上传</button>
                  <button id="cp_avatar" class="menu_button">角色头像</button>
                  <button id="cp_bg" class="menu_button">聊天背景</button>
                </div>
                <div class="cp_row"><input type="text" id="cp_url" placeholder="图片 URL"><button id="cp_urlgo" class="menu_button">载入</button></div>
                <input type="file" id="cp_file" accept="image/*" style="display:none">
              </div>
              <div id="cp_dyn"></div>
              <div class="cp_row">
                <button id="cp_rand" class="menu_button">🎲 重新随机</button>
                <button id="cp_clear" class="menu_button">清除选择</button>
              </div>
              <div class="cp_row">
                <button id="cp_export" class="menu_button">导出 PNG</button>
                <button id="cp_copy" class="menu_button">复制图片</button>
              </div>
            </div>
          </div>
        </div>`;
        document.body.append(overlay);
        cv = $('#cp_canvas'); c2d = cv.getContext('2d');

        const sel = $('#cp_tpl');
        Object.values(TEMPLATES).forEach(t => sel.add(new Option(t.name, t.id)));
        sel.value = getSettings().template;
        sel.addEventListener('change', () => {
            getSettings().template = sel.value; saveSettings();
            buildControls(); render();
        });

        overlay.addEventListener('mousedown', e => { if (e.target === overlay) closePanel(); });
        $('#cp_close').addEventListener('click', closePanel);
        $('#cp_text').addEventListener('input', e => { S.text = e.target.value; scheduleRender(); });

        // 图片来源
        $('#cp_upload').addEventListener('click', () => $('#cp_file').click());
        $('#cp_file').addEventListener('change', async e => {
            const f = e.target.files[0]; if (!f) return;
            try { setImage(await loadImage(URL.createObjectURL(f))); render(); } catch (err) { toast(err.message); }
            e.target.value = '';
        });
        $('#cp_avatar').addEventListener('click', async () => {
            const x = getCtx();
            const ch = x && x.characters && x.characters[x.characterId];
            if (!ch || !ch.avatar) return toast('当前没有选中角色');
            try { setImage(await loadImage('/characters/' + encodeURIComponent(ch.avatar))); render(); } catch (err) { toast(err.message); }
        });
        $('#cp_bg').addEventListener('click', async () => {
            const el = document.getElementById('bg1') || document.body;
            const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
            if (!m) return toast('当前没有聊天背景图');
            try { setImage(await loadImage(m[1])); render(); } catch (err) { toast(err.message); }
        });
        $('#cp_urlgo').addEventListener('click', async () => {
            const u = $('#cp_url').value.trim(); if (!u) return;
            try { setImage(await loadImage(u)); render(); } catch (err) { toast('加载失败（可能是跨域），请改用上传'); }
        });

        // 操作按钮
        $('#cp_rand').addEventListener('click', () => {
            S.seed = Math.floor(Math.random() * 1e6) + 1;
            const tpl = TEMPLATES[getSettings().template];
            if (tpl.reset) tpl.reset(params());
            const P = params();
            if (P.mode === 'manual') {
                // 手动模式下：以随机结果作为起点
                P.mode = 'random'; render(); P.mode = 'manual';
                if (S.cut && S.cut.sig !== 'manual') S.cut.sig = 'manual';
                if (S.keep) S.keep.sig = 'manual';
                if (S.cells) S.cells.sig = 'manual';
            }
            render();
        });
        $('#cp_clear').addEventListener('click', () => {
            const tpl = TEMPLATES[getSettings().template];
            if (!tpl.clear) return;
            const patch = tpl.clear(params()) || {};
            Object.entries(patch).forEach(([k, v]) => ui.setParam(k, v));
            render();
        });
        $('#cp_export').addEventListener('click', () => {
            try {
                cv.toBlob(b => {
                    if (!b) return toast('导出失败：图片跨域，请改用上传');
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(b); a.download = `cutout_${Date.now()}.png`; a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                }, 'image/png');
            } catch (e) { toast('导出失败：图片跨域，请改用上传'); }
        });
        $('#cp_copy').addEventListener('click', () => {
            try {
                cv.toBlob(async b => {
                    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); toast('已复制到剪贴板'); }
                    catch (e) { toast('复制失败，请用"导出 PNG"'); }
                }, 'image/png');
            } catch (e) { toast('复制失败：图片跨域'); }
        });

        // 画布交互
        cv.addEventListener('pointerdown', e => {
            const tpl = TEMPLATES[getSettings().template];
            if (!tpl.onDown) return;
            const [x, y] = canvasXY(e);
            if (tpl.onDown(x, y, params(), ui)) { cv.setPointerCapture(e.pointerId); render(); }
        });
        cv.addEventListener('pointermove', e => {
            const tpl = TEMPLATES[getSettings().template];
            if (!tpl.onMove || !S.drag) return;
            const [x, y] = canvasXY(e);
            if (tpl.onMove(x, y, params())) scheduleRender();
        });
        const up = () => { const tpl = TEMPLATES[getSettings().template]; if (tpl.onUp) tpl.onUp(); };
        cv.addEventListener('pointerup', up);
        cv.addEventListener('pointercancel', up);

        buildControls();
    }

    function closePanel() { overlay.classList.remove('open'); document.body.style.overflow = ''; }

    function openPanel(text) {
        if (!overlay) buildPanel();
        if (typeof text === 'string' && text.trim()) {
            S.text = text.trim();
            $('#cp_text').value = S.text;
            S.keep = null; // 文字变了，涂黑诗重新抽取
        }
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        render();
    }

    /* =====================================================
     * 划词按钮 & 入口
     * ===================================================== */
    function initSelection() {
        const btn = document.createElement('div');
        btn.id = 'cp_float_btn';
        btn.textContent = '✂ 抽取成图';
        document.body.append(btn);
        let lastText = '';
        const hide = () => { btn.style.display = 'none'; };
        const check = () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
            const t = sel.toString().trim();
            if (!t) return hide();
            const n = sel.anchorNode;
            const el = n && n.nodeType === 1 ? n : n && n.parentElement;
            if (!el || !el.closest('#chat .mes_text')) return hide();
            lastText = t;
            const r = sel.getRangeAt(0).getBoundingClientRect();
            btn.style.display = 'block';
            const bw = btn.offsetWidth || 100;
            let top = r.top - 42; if (top < 8) top = r.bottom + 10;
            btn.style.top = top + 'px';
            btn.style.left = clamp(r.left + r.width / 2 - bw / 2, 8, window.innerWidth - bw - 8) + 'px';
        };
        let timer = null;
        document.addEventListener('mouseup', () => setTimeout(check, 10));
        document.addEventListener('touchend', () => setTimeout(check, 200));
        document.addEventListener('selectionchange', () => { clearTimeout(timer); timer = setTimeout(check, 300); });
        btn.addEventListener('pointerdown', e => e.preventDefault());
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', () => { hide(); openPanel(lastText); });
    }

    function addMenuEntry(tries = 0) {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) { if (tries < 20) setTimeout(() => addMenuEntry(tries + 1), 500); return; }
        if (document.getElementById('cp_menu_item')) return;
        const d = document.createElement('div');
        d.id = 'cp_menu_item';
        d.className = 'list-group-item flex-container flexGap5 interactable';
        d.tabIndex = 0;
        d.innerHTML = '<div class="fa-solid fa-scissors extensionsMenuExtensionButton"></div><span>文字抽取成图</span>';
        d.addEventListener('click', () => openPanel(''));
        menu.append(d);
    }

    function init() { initSelection(); addMenuEntry(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
