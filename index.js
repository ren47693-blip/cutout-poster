/* 文字抽取成图 (Cutout Poster) v0.2 - SillyTavern 扩展
 * 全手动操作：点图挖洞 / 点词留字 / 点格子选中，实时预览。
 * 新增模板：CutoutPoster.register({ id, name, controls, defaults, hint, render, ... })
 */
(() => {
    'use strict';

    const EXT = 'cutout_poster';
    const SAMPLE = 'A kaleidoscope of painted wings dances across the vast and tranquil cerulean sky.';

    /* ---------- 基础工具 ---------- */
    const getCtx = () => (window.SillyTavern && SillyTavern.getContext ? SillyTavern.getContext() : null);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function toast(msg) { if (window.toastr) window.toastr.info(msg); else alert(msg); }
    function download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    /* ---------- 设置 ---------- */
    let fallbackSettings = null;
    function getSettings() {
        const c = getCtx();
        let s;
        if (c && c.extensionSettings) { c.extensionSettings[EXT] ??= {}; s = c.extensionSettings[EXT]; }
        else { fallbackSettings ??= JSON.parse(localStorage.getItem(EXT) || '{}'); s = fallbackSettings; }
        s.template ??= 'cutout';
        s.params ??= {};
        s.customFont ??= '';
        s.customShapes ??= [];
        return s;
    }
    function saveSettings() {
        const c = getCtx();
        if (c && c.saveSettingsDebounced) c.saveSettingsDebounced();
        else localStorage.setItem(EXT, JSON.stringify(fallbackSettings));
    }

    /* ---------- IndexedDB（保存导入的字体和模板脚本） ---------- */
    function idb() {
        return new Promise((res, rej) => {
            const r = indexedDB.open('cutout_poster', 1);
            r.onupgradeneeded = () => {
                const d = r.result;
                d.createObjectStore('fonts', { keyPath: 'name' });
                d.createObjectStore('tpls', { keyPath: 'name' });
            };
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async function dbAll(store) {
        const d = await idb();
        return new Promise((res, rej) => {
            const q = d.transaction(store).objectStore(store).getAll();
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
    }
    async function dbPut(store, val) {
        const d = await idb();
        return new Promise((res, rej) => {
            const t = d.transaction(store, 'readwrite');
            t.objectStore(store).put(val);
            t.oncomplete = () => res(); t.onerror = () => rej(t.error);
        });
    }

    /* ---------- 文字处理 ---------- */
    const CJK = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
    const TOKEN_RE = new RegExp(`\\{\\s*\\}|[${CJK}]|[^\\s${CJK}{]+|\\{`, 'g');
    let segmenter = null;
    function tokenizeLine(line, gran) {
        const out = [];
        if (gran === 'word' && window.Intl && Intl.Segmenter) {
            segmenter ??= new Intl.Segmenter(['zh', 'en'], { granularity: 'word' });
            for (const part of line.split(/(\{\s*\})/)) {
                if (!part) continue;
                if (/^\{\s*\}$/.test(part)) { out.push({ t: part, slot: true, sp: false }); continue; }
                for (const sg of segmenter.segment(part)) {
                    const t = sg.segment;
                    if (/^\s+$/.test(t)) { if (out.length) out[out.length - 1].sp = true; continue; }
                    out.push({ t, slot: false, sp: false });
                }
            }
            return out;
        }
        let m;
        TOKEN_RE.lastIndex = 0;
        while ((m = TOKEN_RE.exec(line))) {
            const t = m[0], nxt = line[m.index + t.length];
            out.push({ t, slot: /^\{\s*\}$/.test(t), sp: !!nxt && /\s/.test(nxt) });
        }
        return out;
    }
    function tokenize(text, gran) {
        const lines = String(text).replace(/\r/g, '').split('\n');
        const out = [];
        lines.forEach((ln, li) => {
            if (li) out.push({ nl: true, t: '\n', slot: false, sp: false });
            out.push(...tokenizeLine(ln, gran));
        });
        return out;
    }
    function wrap(items, maxW) {
        const lines = [];
        let cur = [], w = 0;
        for (const it of items) {
            if (it.nl) { cur.push(it); lines.push({ items: cur, w }); cur = []; w = 0; continue; }
            if (cur.length && w + it.w > maxW + 1) { lines.push({ items: cur, w }); cur = []; w = 0; }
            cur.push(it); w += it.w;
        }
        if (cur.length) lines.push({ items: cur, w });
        return lines;
    }
    const mctx = document.createElement('canvas').getContext('2d');

    /* ---------- 字体 ---------- */
    const importedFonts = [];
    function FONT_OPTS() {
        return [
            ['theme', '酒馆主题字体'], ['sans', '无衬线'], ['serif', '衬线'], ['mono', '等宽'],
            ['kai', '楷体/手写'], ['custom', '自己输入字体名'],
            ...importedFonts.map(n => ['imp:' + n, '📁 ' + n]),
        ];
    }
    function fontFamily(k) {
        if (k === 'theme') return getComputedStyle(document.body).fontFamily || 'sans-serif';
        if (k === 'custom') { const n = getSettings().customFont; return n ? `"${n}", sans-serif` : 'sans-serif'; }
        if (k && k.startsWith('imp:')) return `"${k.slice(4)}", sans-serif`;
        return ({
            sans: 'Inter, "PingFang SC", "Microsoft YaHei", Arial, sans-serif',
            serif: '"Playfair Display", "Songti SC", SimSun, Georgia, serif',
            mono: '"Courier New", Menlo, monospace',
            kai: 'KaiTi, "Kaiti SC", STKaiti, cursive, serif',
        })[k] || 'sans-serif';
    }
    async function loadSavedFonts() {
        try {
            for (const rec of await dbAll('fonts')) {
                try {
                    const ff = new FontFace(rec.name, rec.buf);
                    await ff.load(); document.fonts.add(ff);
                    if (!importedFonts.includes(rec.name)) importedFonts.push(rec.name);
                } catch (e) { console.warn('[CutoutPoster] font load failed', rec.name, e); }
            }
        } catch (e) { /* IndexedDB 不可用时忽略 */ }
    }

    /* ---------- 图形路径 ---------- */
    function pathShape(c, shape, cx, cy, w, h) {
        const x = cx - w / 2, y = cy - h / 2;
        c.beginPath();
        switch (shape) {
            case 'circle': case 'ellipse':
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
            case 'puzzle': {
                const sz = Math.min(w, h) * 0.65, r = sz * 0.17, d = r * 0.55, k = Math.sqrt(r * r - d * d), a = Math.atan2(d, k);
                const x0 = cx - sz / 2, y0 = cy - sz / 2, x1 = cx + sz / 2, y1 = cy + sz / 2, PI = Math.PI;
                c.moveTo(x0, y0); c.lineTo(cx - k, y0);
                c.arc(cx, y0 - d, r, PI - a, 2 * PI + a, false);
                c.lineTo(x1, y0); c.lineTo(x1, cy - k);
                c.arc(x1 + d, cy, r, 1.5 * PI - a, 2.5 * PI + a, false);
                c.lineTo(x1, y1); c.lineTo(cx + k, y1);
                c.arc(cx, y1 - d, r, a, PI - a, true);
                c.lineTo(x0, y1); c.lineTo(x0, cy + k);
                c.arc(x0 + d, cy, r, a + PI / 2, 1.5 * PI - a, true);
                c.closePath(); break;
            }
            case 'drop': {
                const r = w / 2, cyc = y + h - r, D = cyc - y, g = Math.acos(Math.min(0.99, r / Math.max(D, r + 1)));
                c.moveTo(cx, y);
                c.lineTo(cx + r * Math.cos(-Math.PI / 2 + g), cyc + r * Math.sin(-Math.PI / 2 + g));
                c.arc(cx, cyc, r, -Math.PI / 2 + g, 1.5 * Math.PI - g, false);
                c.closePath(); break;
            }
            case 'sparkle': {
                const k = 0.09;
                c.moveTo(cx, y);
                c.quadraticCurveTo(cx + w * k, cy - h * k, x + w, cy);
                c.quadraticCurveTo(cx + w * k, cy + h * k, cx, y + h);
                c.quadraticCurveTo(cx - w * k, cy + h * k, x, cy);
                c.quadraticCurveTo(cx - w * k, cy - h * k, cx, y);
                c.closePath(); break;
            }
            default: {
                if (typeof shape === 'string' && shape.startsWith('custom:')) {
                    const cs = (getSettings().customShapes || [])[+shape.slice(7)];
                    if (cs && cs.pts && cs.pts.length >= 3) {
                        const n = cs.pts.length;
                        const pt = i => { const q = cs.pts[((i % n) + n) % n]; return [cx + q[0] * w, cy + q[1] * h]; };
                        const a0 = pt(0), b0 = pt(1);
                        c.moveTo((a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2);
                        for (let i = 1; i <= n; i++) { const q = pt(i), r = pt(i + 1); c.quadraticCurveTo(q[0], q[1], (q[0] + r[0]) / 2, (q[1] + r[1]) / 2); }
                        c.closePath(); break;
                    }
                }
                c.rect(x, y, w, h);
            }
        }
    }

    /* ---------- 运行时状态 ---------- */
    const S = {
        text: '', img: null, imgId: 0, hits: [], geo: null,
        cut: { holes: [] }, sel: -1, slots: new Set(), keep: null, cells: null,
        edges: {}, tl: null, boxes: [], tmpBox: null, det: null, noGuides: false,
        cloze: { order: [], pos: {} }, clozeGeo: null, srcImg: null,
        drag: null, undo: [], ctls: {},
    };
    const TEMPLATES = {};
    const imgW = im => im.naturalWidth || im.width;
    const imgH = im => im.naturalHeight || im.height;

    /* ---------- 通用绘图/文字小工具 ---------- */
    function drawCover(c, img, x, y, w, h) {
        const sc = Math.max(w / imgW(img), h / imgH(img));
        const sw = w / sc, sh = h / sc;
        c.drawImage(img, (imgW(img) - sw) / 2, (imgH(img) - sh) / 2, sw, sh, x, y, w, h);
    }
    const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    function textLines(fallback) {
        const raw = (S.text || '').replace(/\r/g, '').trim() || fallback || SAMPLE;
        return raw.split('\n').map(t => t.trim());
    }
    const unitsOf = t => { t = t.trim(); return /\s/.test(t) ? t.split(/\s+/) : [...t]; };
    function romanize(n) {
        let r = '';
        for (const [v, t] of [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { r += t; n -= v; }
        return r;
    }
    const RATIOS = { '3:2': [3, 2], '16:9': [16, 9], '4:3': [4, 3], '1:1': [1, 1], '3:4': [3, 4], '2:3': [2, 3] };
    const RATIO_OPTS = [['3:2', '3:2 横'], ['16:9', '16:9 横'], ['4:3', '4:3 横'], ['1:1', '方形'], ['3:4', '3:4 竖'], ['2:3', '2:3 竖']];
    // 需要先设置 mctx.font；返回按宽度折行后的每行字符串
    function textBlock(text, maxW) {
        const spaceW = mctx.measureText(' ').width;
        const items = tokenize(text, 'char').map(tk => tk.nl ? { nl: true, w: 0 } : { t: tk.t, sp: tk.sp, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
        return wrap(items, maxW).map(l => l.items.filter(i => !i.nl).map(i => i.t + (i.sp ? ' ' : '')).join(''));
    }

    let noiseCv = null;
    function applyGrain(c, w, h, amount) {
        if (!amount) return;
        if (!noiseCv) {
            noiseCv = document.createElement('canvas'); noiseCv.width = noiseCv.height = 200;
            const nc = noiseCv.getContext('2d'), id = nc.createImageData(200, 200);
            for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
            nc.putImageData(id, 0, 0);
        }
        c.save(); c.globalAlpha = Math.min(1, amount / 100 * 0.35); c.globalCompositeOperation = 'overlay';
        c.fillStyle = c.createPattern(noiseCv, 'repeat'); c.fillRect(0, 0, w, h); c.restore();
    }
    /* ---------- 自定义形状：轮廓简化 / 从图片提取 ---------- */
    function simplifyPts(pts, eps) {
        if (pts.length < 3) return pts;
        const keep = new Uint8Array(pts.length);
        keep[0] = keep[pts.length - 1] = 1;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, len = Math.hypot(dx, dy) || 1e-9;
            let md = 0, mi = -1;
            for (let i = a + 1; i < b; i++) {
                const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
                if (d > md) { md = d; mi = i; }
            }
            if (mi >= 0 && md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
        }
        return pts.filter((_, i) => keep[i]);
    }
    function normalizeShape(raw) {
        const xs = raw.map(q => q[0]), ys = raw.map(q => q[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const bw = Math.max(1e-6, x1 - x0), bh = Math.max(1e-6, y1 - y0);
        let pts = raw.map(q => [(q[0] - x0) / bw - 0.5, (q[1] - y0) / bh - 0.5]);
        let eps = 0.006;
        pts = simplifyPts(pts, eps);
        while (pts.length > 70) { eps *= 1.4; pts = simplifyPts(pts, eps); }
        if (pts.length < 3) return null;
        return { pts: pts.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]), ratio: clamp(bh / bw, 0.2, 5) };
    }
    function largestComponent(mask, n) {
        const lab = new Int32Array(n * n);
        let best = 0, bestId = 0, id = 0;
        const stack = [];
        for (let i = 0; i < n * n; i++) {
            if (!mask[i] || lab[i]) continue;
            id++; let cnt = 0; stack.push(i); lab[i] = id;
            while (stack.length) {
                const j = stack.pop(); cnt++;
                const x = j % n, y = (j - x) / n;
                if (x > 0 && mask[j - 1] && !lab[j - 1]) { lab[j - 1] = id; stack.push(j - 1); }
                if (x < n - 1 && mask[j + 1] && !lab[j + 1]) { lab[j + 1] = id; stack.push(j + 1); }
                if (y > 0 && mask[j - n] && !lab[j - n]) { lab[j - n] = id; stack.push(j - n); }
                if (y < n - 1 && mask[j + n] && !lab[j + n]) { lab[j + n] = id; stack.push(j + n); }
            }
            if (cnt > best) { best = cnt; bestId = id; }
        }
        const out = new Uint8Array(n * n);
        for (let i = 0; i < n * n; i++) out[i] = lab[i] === bestId ? 1 : 0;
        return out;
    }
    function traceContour(mask, n) {
        const D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
        let sx = -1, sy = -1;
        outer: for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (mask[y * n + x]) { sx = x; sy = y; break outer; }
        if (sx < 0) return null;
        const at = (x, y) => x >= 0 && y >= 0 && x < n && y < n && mask[y * n + x];
        const pts = [[sx, sy]];
        let bx = sx, by = sy, back = 4;
        for (let step = 0; step < n * n * 2; step++) {
            let found = false;
            for (let i = 1; i <= 8; i++) {
                const d = (back + i) % 8, nx = bx + D[d][0], ny = by + D[d][1];
                if (at(nx, ny)) {
                    const pd = (back + i - 1 + 8) % 8, px = bx + D[pd][0], py = by + D[pd][1];
                    back = D.findIndex(v => v[0] === px - nx && v[1] === py - ny);
                    bx = nx; by = ny; found = true; break;
                }
            }
            if (!found) break;
            if (bx === sx && by === sy) break;
            pts.push([bx, by]);
        }
        return pts;
    }
    function shapeFromImage(im) {
        const n = 200, cv0 = document.createElement('canvas');
        cv0.width = cv0.height = n;
        const c0 = cv0.getContext('2d');
        const sc = Math.min(n / imgW(im), n / imgH(im)), w = imgW(im) * sc, h = imgH(im) * sc;
        c0.drawImage(im, (n - w) / 2, (n - h) / 2, w, h);
        let d;
        try { d = c0.getImageData(0, 0, n, n).data; } catch (e) { return null; }
        let transparent = 0;
        for (let i = 0; i < n * n; i++) if (d[i * 4 + 3] < 250) transparent++;
        const useAlpha = transparent > n * n * 0.02;
        const mask = new Uint8Array(n * n);
        for (let i = 0; i < n * n; i++) {
            const a = d[i * 4 + 3];
            if (useAlpha) mask[i] = a > 128 ? 1 : 0;
            else { const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; mask[i] = (a > 128 && l < 140) ? 1 : 0; }
        }
        const pts = traceContour(largestComponent(mask, n), n);
        if (!pts || pts.length < 8) return null;
        return normalizeShape(pts);
    }
    window.__cpGeo = { traceContour, largestComponent, normalizeShape, simplifyPts };
    const SAMPLE_CLOZE = '夫天地者，万物之逆旅也；\n光阴者，百代之过客也。\n而浮生若梦，为欢几何？';
    const SAMPLE_TIMELINE = '5/12  CONCEPT PHOTO #1\n5/15  CONCEPT PHOTO #2\n5/16  CONCEPT PHOTO #3\n\n5/22  TRACKLIST\n\n5/29  ALBUM RELEASE';
    const SAMPLE_DETECT = 'maybe we are all main characters\njust crossing paths in each others stories';
    const SAMPLE_BOARD = 'DESIGN AND RESEARCH\nThis design proposal developed out of the practice of making large-scale drawings, models and environments.\nTime-based plan of the proposed process\nSketch development\nModel, restoration hangar\nPortfolio, precedents\nBuilding components booklet\nRelief section';

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

    /* =====================================================
     * 模板 1：挖洞置换（全手动）
     * ===================================================== */
    // 每个洞存：中心点、大小(% 图片宽度)、洞的角度 hrot、碎片的角度 rot；形状是全局参数
    const BASE_SHAPES = [['square', '方形'], ['circle', '圆形'], ['rect', '长方形'], ['ellipse', '椭圆'], ['diamond', '菱形'], ['triangle', '三角'], ['star', '星形'], ['heart', '爱心'], ['puzzle', '拼图'], ['drop', '水滴'], ['sparkle', '四角星光']];
    function SHAPE_OPTS() {
        const cs = getSettings().customShapes || [];
        return [...BASE_SHAPES, ...cs.map((q, i) => q ? ['custom:' + i, '自定义 ' + (i + 1)] : null).filter(Boolean)];
    }
    const SHAPE_ASPECT = { drop: 1.35 };   // 高/宽
    function shapeRatio(P) {
        if (P.shape === 'rect' || P.shape === 'ellipse') return 1 / Math.max(0.2, P.aspect);
        if (typeof P.shape === 'string' && P.shape.startsWith('custom:')) {
            const cs = (getSettings().customShapes || [])[+P.shape.slice(7)];
            return cs ? clamp(cs.ratio, 0.2, 5) : 1;
        }
        return SHAPE_ASPECT[P.shape] || 1;
    }
    function holeGeom(P, h, IW, IH) {
        const w = (h.size ?? P.size) / 100;
        const hp = (IW * w * shapeRatio(P)) / IH;
        return {
            cx: clamp(h.cx, Math.min(w / 2, 0.5), Math.max(1 - w / 2, 0.5)),
            cy: clamp(h.cy, Math.min(hp / 2, 0.5), Math.max(1 - hp / 2, 0.5)),
            w, h: hp,
        };
    }
    // 碎片：rot = 碎片自己的角度；hrot = 洞的角度（碎片里的图案要按洞的方向取，再转回来）
    function drawFrag(c, P, g, dcx, dcy, dw, dh, rot, hrot) {
        const img = S.img, iwp = imgW(img), ihp = imgH(img);
        c.save();
        c.translate(dcx, dcy);
        if (rot) c.rotate(rot * Math.PI / 180);
        c.save();
        pathShape(c, P.shape, 0, 0, dw, dh);
        c.clip();
        if (hrot) c.rotate(-hrot * Math.PI / 180);
        const D = Math.hypot(g.w * iwp, g.h * ihp), D2 = Math.hypot(dw, dh);
        c.drawImage(img, g.cx * iwp - D / 2, g.cy * ihp - D / 2, D, D, -D2 / 2, -D2 / 2, D2, D2);
        c.restore();
        if (P.border) { pathShape(c, P.shape, 0, 0, dw, dh); c.lineWidth = 2; c.strokeStyle = P.fg; c.stroke(); }
        c.restore();
    }
    function drawRing(c, P, cx, cy, w, h, ang) {
        c.save(); c.translate(cx, cy); if (ang) c.rotate(ang * Math.PI / 180);
        c.setLineDash([10, 7]); c.lineWidth = 4; c.strokeStyle = '#3b9bff';
        pathShape(c, P.shape, 0, 0, w + 12, h + 12); c.stroke(); c.restore();
    }
    function fillHole(c, P, cx, cy, w, h, ang) {
        c.save(); c.translate(cx, cy); if (ang) c.rotate(ang * Math.PI / 180);
        pathShape(c, P.shape, 0, 0, w, h); c.fillStyle = P.bg; c.fill(); c.restore();
    }

    const cutout = {
        id: 'cutout',
        name: '挖洞置换',
        hint(P) {
            return '点空白处挖洞；点洞选中（在「样式」里调大小、洞的角度、碎片的角度），按住洞可拖动，再点一下选中的洞删除。'
                + (P.layout === 'slots' ? '点文字：这个字会被碎片替换（再点恢复）。槽位按文字顺序装入先挖的洞。' : '图外的碎片可以拖动。');
        },
        migrate(P) {
            if (P.layout === 'below') { P.layout = 'panel'; P.side = 'below'; }
            if (P.shape === 'bird') P.shape = 'circle';
        },
        defaults: {
            layout: 'panel', side: 'below', arrange: 'mirror', panelPct: 100, framePct: 14, spread: 30, gridCols: 6,
            glyph: '', fillGlyph: true, fragScale: 100, gran: 'char', slotMode: 'replace', slotScale: 1.25,
            shape: 'square', aspect: 1.5, size: 12,
            bg: '#f1efe6', fg: '#222222', glyphColor: '#ffffff', border: false, fontSize: 3.4, font: 'theme', grain: 0,
        },
        controls: [
            { group: '版面', key: 'layout', label: '碎片放在哪', type: 'select', options: [['panel', '图旁边的空白区'], ['frame', '图外一圈边框里'], ['slots', '文字里（替换文字）']] },
            { group: '版面', key: 'side', label: '空白区位置', type: 'select', options: [['below', '下方'], ['above', '上方'], ['right', '右边'], ['left', '左边']], show: P => P.layout === 'panel' },
            { group: '版面', key: 'arrange', label: '碎片排列', type: 'select', options: [['mirror', '对应原位置'], ['cluster', '聚拢成一堆'], ['grid', '整齐网格'], ['glyph', '排成一个字']], show: P => P.layout === 'panel' },
            { group: '版面', key: 'panelPct', label: '空白区大小 %', type: 'range', min: 30, max: 160, step: 5, show: P => P.layout === 'panel' },
            { group: '版面', key: 'framePct', label: '边框宽度 %', type: 'range', min: 5, max: 35, step: 1, show: P => P.layout === 'frame' },
            { group: '版面', key: 'spread', label: '聚拢程度 %', type: 'range', min: 5, max: 100, step: 5, show: P => P.layout === 'panel' && P.arrange === 'cluster' },
            { group: '版面', key: 'gridCols', label: '网格列数', type: 'range', min: 2, max: 12, step: 1, show: P => P.layout === 'panel' && P.arrange === 'grid' },
            { group: '版面', key: 'glyph', label: '要排成的字（空=取文字第一个字）', type: 'text', show: P => P.layout === 'panel' && P.arrange === 'glyph' },
            { group: '版面', key: 'fillGlyph', label: '碎片重复，铺满字形', type: 'checkbox', show: P => P.layout === 'panel' && P.arrange === 'glyph' },
            { group: '版面', key: 'fragScale', label: '碎片缩放 %', type: 'range', min: 30, max: 150, step: 5, show: P => P.layout !== 'slots' },
            { group: '版面', key: 'gran', label: '文字点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词']], show: P => P.layout === 'slots', onChange() { S.slots = new Set(); } },
            { group: '版面', key: 'slotMode', label: '碎片放上去后', type: 'select', options: [['replace', '替换这个字（字消失）'], ['insert', '插在这个字后面（字保留）']], show: P => P.layout === 'slots' },
            { group: '版面', key: 'slotScale', label: '文字里的碎片大小', type: 'range', min: 0.6, max: 3, step: 0.05, show: P => P.layout === 'slots' },
            { group: '形状', key: 'shape', label: '洞的形状', type: 'select', options: SHAPE_OPTS },
            { group: '形状', key: 'aspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1, show: P => P.shape === 'rect' || P.shape === 'ellipse' },
            { group: '形状', key: 'drawShape', label: '手绘一个自定义形状', type: 'button', noUndo: true, onClick() { ui.openShapePad(); } },
            { group: '形状', key: 'imgShape', label: '用图片做形状（透明底或白底深色图案）', type: 'button', noUndo: true, onClick() { ui.pickShapeImage(); } },
            { group: '形状', key: 'delShape', label: '删除这个自定义形状', type: 'button', noUndo: true, show: P => String(P.shape).startsWith('custom:'), onClick(P) { ui.deleteCustomShape(P.shape); } },
            { group: '大小与角度', key: 'size', label: '新洞的默认大小 %', type: 'range', min: 3, max: 40, step: 1 },
            { group: '大小与角度', key: 'selSize', label: '选中的洞：大小 %', type: 'range', min: 2, max: 60, step: 1, show: () => S.sel >= 0,
              get(P) { const h = S.cut.holes[S.sel]; return h ? (h.size ?? P.size) : undefined; },
              set(v) { const h = S.cut.holes[S.sel]; if (h) h.size = v; } },
            { group: '大小与角度', key: 'selHoleRot', label: '选中的洞：洞的角度', type: 'range', min: -180, max: 180, step: 5, show: () => S.sel >= 0,
              get() { const h = S.cut.holes[S.sel]; return h ? (h.hrot || 0) : undefined; },
              set(v) { const h = S.cut.holes[S.sel]; if (h) h.hrot = v; } },
            { group: '大小与角度', key: 'selRot', label: '选中的碎片：碎片的角度', type: 'range', min: -180, max: 180, step: 5, show: () => S.sel >= 0,
              get() { const h = S.cut.holes[S.sel]; return h ? (h.rot || 0) : undefined; },
              set(v) { const h = S.cut.holes[S.sel]; if (h) h.rot = v; } },
            { group: '大小与角度', key: 'delSel', label: '删除选中的洞', type: 'button', show: () => S.sel >= 0, onClick() { if (S.sel >= 0) S.cut.holes.splice(S.sel, 1); S.sel = -1; } },
            { group: '大小与角度', key: 'allSize', label: '所有洞改成默认大小', type: 'button', onClick(P) { S.cut.holes.forEach(h => { h.size = P.size; }); } },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.5, max: 6, step: 0.1, show: P => P.layout === 'slots' },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS, show: P => P.layout === 'slots' || (P.layout === 'panel' && P.arrange === 'glyph') },
            { group: '颜色', key: 'bg', label: '底色/洞色', type: 'color' },
            { group: '颜色', key: 'fg', label: '文字/描边色', type: 'color' },
            { group: '颜色', key: 'glyphColor', label: '字形颜色', type: 'color', show: P => P.layout === 'panel' && P.arrange === 'glyph' },
            { group: '颜色', key: 'border', label: '碎片描边', type: 'checkbox' },
            { group: '质感', key: 'grain', label: '纸张颗粒 %', type: 'range', min: 0, max: 100, step: 5 },
        ],
        snap() { return JSON.stringify({ h: S.cut.holes, s: [...S.slots] }); },
        restore(str) { const d = JSON.parse(str); S.cut.holes = d.h; S.slots = new Set(d.s); S.sel = -1; },
        clear() { S.cut.holes = []; S.slots = new Set(); S.sel = -1; },
        render(cv, c, P) {
            const img = S.img, holes = S.cut.holes;
            const IW = 1200, IH = Math.round(IW * imgH(img) / imgW(img));
            if (S.sel >= holes.length) S.sel = -1;
            if (P.layout === 'slots') {
                const G0 = holes.map(h => holeGeom(P, h, IW, IH));
                renderSlots(cv, c, P, IW, IW, IH, holes, G0);
                applyGrain(c, cv.width, cv.height, P.grain);
                return;
            }
            let W, H, ix = 0, iy = 0, iw = IW, ih = IH, panel;
            if (P.layout === 'frame') {
                const m = Math.round(IW * P.framePct / 100);
                iw = IW - 2 * m; ih = Math.round(iw * imgH(img) / imgW(img));
                W = IW; H = ih + 2 * m; ix = m; iy = m; panel = { x: 0, y: 0, w: W, h: H };
            } else if (P.side === 'below' || P.side === 'above') {
                const ph = Math.round(IH * P.panelPct / 100);
                W = IW; H = IH + ph; iy = P.side === 'above' ? ph : 0;
                panel = { x: 0, y: P.side === 'above' ? 0 : IH, w: IW, h: ph };
            } else {
                const pw = Math.round(IW * P.panelPct / 100);
                W = IW + pw; H = IH; ix = P.side === 'left' ? pw : 0;
                panel = { x: P.side === 'left' ? 0 : IW, y: 0, w: pw, h: IH };
            }
            cv.width = W; cv.height = H;
            c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
            c.drawImage(img, ix, iy, iw, ih);
            S.geo = { x: ix, y: iy, w: iw, h: ih };
            const G = holes.map(h => holeGeom(P, h, iw, ih));
            G.forEach((g, i) => fillHole(c, P, ix + g.cx * iw, iy + g.cy * ih, g.w * iw, g.h * ih, holes[i].hrot || 0));
            const fsc = P.fragScale / 100;
            const sizes = G.map(g => ({ w: g.w * iw * fsc, h: g.h * ih * fsc }));
            let centers = null;
            if (P.layout === 'frame') {
                centers = G.map((g, i) => {
                    const sd = Math.floor(hash(i * 5 + 2) * 4), al = hash(i * 5 + 3), of = ix * 0.12 + hash(i * 5 + 4) * ix * 0.76;
                    if (sd === 0) return { x: ix + al * iw, y: of };
                    if (sd === 1) return { x: ix + al * iw, y: H - of };
                    if (sd === 2) return { x: of, y: iy + al * ih };
                    return { x: W - of, y: iy + al * ih };
                });
            } else if (P.arrange === 'cluster') {
                const cx0 = panel.x + panel.w / 2, cy0 = panel.y + panel.h / 2, sp = P.spread / 100;
                centers = G.map(g => ({ x: cx0 + (g.cx - 0.5) * panel.w * sp, y: cy0 + (g.cy - 0.5) * panel.h * sp }));
            } else if (P.arrange === 'grid') {
                const n = G.length, cols = Math.max(1, Math.min(P.gridCols, n || 1));
                const cell = Math.max(1, ...sizes.map(z => Math.max(z.w, z.h))) * 1.2, rows = Math.ceil(n / cols);
                const x0 = panel.x + panel.w / 2 - cols * cell / 2 + cell / 2, y0 = panel.y + panel.h / 2 - rows * cell / 2 + cell / 2;
                centers = G.map((g, i) => ({ x: x0 + (i % cols) * cell, y: y0 + Math.floor(i / cols) * cell }));
            } else if (P.arrange !== 'glyph') {
                centers = G.map(g => ({ x: panel.x + g.cx * panel.w, y: panel.y + g.cy * panel.h }));
            }
            if (centers) {
                G.forEach((g, i) => {
                    const o = holes[i];
                    const dx = centers[i].x + (o.ox || 0), dy = centers[i].y + (o.oy || 0);
                    drawFrag(c, P, g, dx, dy, sizes[i].w, sizes[i].h, o.rot || 0, o.hrot || 0);
                    S.hits.push({ kind: 'frag', i, x: dx - sizes[i].w / 2, y: dy - sizes[i].h / 2, w: sizes[i].w, h: sizes[i].h });
                });
                if (!S.noGuides && S.sel >= 0 && G[S.sel]) {
                    const o = holes[S.sel];
                    drawRing(c, P, centers[S.sel].x + (o.ox || 0), centers[S.sel].y + (o.oy || 0), sizes[S.sel].w, sizes[S.sel].h, o.rot || 0);
                }
            } else {
                const ch = (P.glyph || '').trim().slice(0, 2) || (S.text || '').trim().slice(0, 1) || '字';
                const gs = Math.min(panel.w, panel.h) * 0.78, fam = fontFamily(P.font);
                c.save(); c.fillStyle = P.glyphColor; c.font = `bold ${gs}px ${fam}`; c.textAlign = 'center'; c.textBaseline = 'middle';
                c.fillText(ch, panel.x + panel.w / 2, panel.y + panel.h / 2); c.restore();
                if (holes.length) {
                    const sc = 0.25, mk = document.createElement('canvas');
                    mk.width = Math.ceil(panel.w * sc); mk.height = Math.ceil(panel.h * sc);
                    const mc = mk.getContext('2d');
                    mc.font = `bold ${gs * sc}px ${fam}`; mc.textAlign = 'center'; mc.textBaseline = 'middle'; mc.fillStyle = '#000';
                    mc.fillText(ch, mk.width / 2, mk.height / 2);
                    let md = null;
                    try { md = mc.getImageData(0, 0, mk.width, mk.height).data; } catch (e) { md = null; }
                    const cell = Math.max(10, sizes.reduce((s0, z) => s0 + Math.max(z.w, z.h), 0) / sizes.length * 1.05);
                    const spots = [];
                    for (let yy = panel.y + cell / 2; yy < panel.y + panel.h; yy += cell) {
                        for (let xx = panel.x + cell / 2; xx < panel.x + panel.w; xx += cell) {
                            const px = Math.floor((xx - panel.x) * sc), py = Math.floor((yy - panel.y) * sc);
                            if (!md || md[(py * mk.width + px) * 4 + 3] > 100) spots.push({ x: xx, y: yy });
                        }
                    }
                    const n = holes.length, take = P.fillGlyph ? spots.length : Math.min(n, spots.length);
                    for (let k = 0; k < take; k++) {
                        const i = k % n, z = sizes[i], f = cell * 0.92 / Math.max(z.w, z.h);
                        drawFrag(c, P, G[i], spots[k].x, spots[k].y, z.w * f, z.h * f, holes[i].rot || 0, holes[i].hrot || 0);
                    }
                }
            }
            if (!S.noGuides && S.sel >= 0 && G[S.sel]) {
                const g = G[S.sel];
                drawRing(c, P, ix + g.cx * iw, iy + g.cy * ih, g.w * iw, g.h * ih, holes[S.sel].hrot || 0);
            }
            applyGrain(c, W, H, P.grain);
        },
        onDown(x, y, P) {
            const inside = h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if (h.kind === 'frag' && inside(h)) {
                    const ho = S.cut.holes[h.i];
                    S.sel = h.i;
                    S.drag = { kind: 'frag', i: h.i, sx: x, sy: y, ox: ho.ox || 0, oy: ho.oy || 0 };
                    return true;
                }
            }
            if (P.layout === 'slots') {
                const t = S.hits.find(h => (h.kind === 'sslot' || h.kind === 'stok') && inside(h));
                if (t) { S.slots.has(t.i) ? S.slots.delete(t.i) : S.slots.add(t.i); return true; }
            }
            const g = S.geo;
            if (!g || x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return false;
            const fx = (x - g.x) / g.w, fy = (y - g.y) / g.h;
            const holes = S.cut.holes;
            let hit = -1;
            for (let k = holes.length - 1; k >= 0; k--) {
                const q = holeGeom(P, holes[k], g.w, g.h);
                const a = -(holes[k].hrot || 0) * Math.PI / 180, dx = (fx - q.cx) * g.w, dy = (fy - q.cy) * g.h;
                const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
                if (Math.abs(lx) <= q.w * g.w / 2 && Math.abs(ly) <= q.h * g.h / 2) { hit = k; break; }
            }
            if (hit >= 0) {
                S.drag = { kind: 'hole', i: hit, sx: x, sy: y, cx0: holes[hit].cx, cy0: holes[hit].cy, moved: false, was: S.sel === hit };
                S.sel = hit;
                return true;
            }
            holes.push({ cx: fx, cy: fy, ox: 0, oy: 0, rot: 0, hrot: 0, size: P.size });
            S.sel = holes.length - 1;
            return true;
        },
        onMove(x, y) {
            const d = S.drag;
            if (!d) return false;
            const ho = S.cut.holes[d.i];
            if (!ho) return false;
            if (d.kind === 'frag') { ho.ox = d.ox + (x - d.sx); ho.oy = d.oy + (y - d.sy); return true; }
            if (d.kind === 'hole') {
                const g = S.geo;
                if (Math.hypot(x - d.sx, y - d.sy) > 6) d.moved = true;
                if (d.moved && g) { ho.cx = clamp(d.cx0 + (x - d.sx) / g.w, 0, 1); ho.cy = clamp(d.cy0 + (y - d.sy) / g.h, 0, 1); }
                return true;
            }
            return false;
        },
        onUp() {
            const d = S.drag;
            if (d && d.kind === 'hole' && !d.moved && d.was) { S.cut.holes.splice(d.i, 1); S.sel = -1; }
            S.drag = null;
        },
    };

    function renderSlots(cv, c, P, W, IW, IH, holes, G) {
        const fs = Math.round(W * P.fontSize / 100);
        const fam = fontFamily(P.font);
        mctx.font = `${fs}px ${fam}`;
        const base = tokenize((S.text || '').trim() || SAMPLE, P.gran);
        const toks = [];
        base.forEach((t, i) => {
            if (!t.slot && !t.nl && S.slots.has(i)) {
                if (P.slotMode === 'insert') {
                    toks.push(Object.assign({}, t, { ti: i }));
                    toks.push({ t: '{ }', slot: true, sp: true, ti: -1, after: i });
                } else toks.push({ t: '{ }', slot: true, sp: t.sp, ti: -1, after: i, orig: t.t });
            } else toks.push(Object.assign({}, t, { ti: i }));
        });
        const spaceW = mctx.measureText(' ').width;
        let slotI = 0;
        const items = toks.map(tk => {
            if (tk.nl) return { nl: true, w: 0 };
            if (tk.slot) {
                const i = slotI++, g = G[i];
                if (!g && tk.orig !== undefined) {   // 还没有碎片可放：先显示原字
                    return { t: tk.orig, pend: true, after: tk.after, w: mctx.measureText(tk.orig).width + (tk.sp ? spaceW : 0) };
                }
                let fh = fs * P.slotScale, fw = g ? fh * (g.w * IW) / (g.h * IH) : fh;
                const cap = W * 0.28;
                if (fw > cap) { fw = cap; fh = g ? fw * (g.h * IH) / (g.w * IW) : fw; }
                return { slot: true, i, fw, fh, after: tk.after, w: fw + fs * 0.12 + (tk.sp ? spaceW : 0) };
            }
            return { t: tk.t, ti: tk.ti, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) };
        });
        const lines = wrap(items, W * 0.84);
        lines.forEach(l => {
            const mf = Math.max(0, ...l.items.filter(i => i.slot).map(i => i.fh));
            l.lh = Math.max(fs * 1.9, mf ? mf + fs * 0.6 : 0);
        });
        const pad = fs * 2.5;
        const textH = Math.round(pad * 2 + lines.reduce((s0, l) => s0 + l.lh, 0));
        cv.width = W; cv.height = textH + IH;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, cv.height);
        c.drawImage(S.img, 0, textH, IW, IH);
        S.geo = { x: 0, y: textH, w: IW, h: IH };
        G.forEach((g, i) => fillHole(c, P, g.cx * IW, textH + g.cy * IH, g.w * IW, g.h * IH, holes[i].hrot || 0));
        if (!S.noGuides && S.sel >= 0 && G[S.sel]) { const g = G[S.sel]; drawRing(c, P, g.cx * IW, textH + g.cy * IH, g.w * IW, g.h * IH, holes[S.sel].hrot || 0); }
        c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'left';
        let y = pad;
        lines.forEach(l => {
            let x = (W - l.w) / 2;
            const cy = y + l.lh / 2;
            l.items.forEach(it => {
                if (it.nl) return;
                if (it.slot) {
                    const fx = x + fs * 0.06, g = G[it.i];
                    if (g) drawFrag(c, P, g, fx + it.fw / 2, cy, it.fw, it.fh, holes[it.i].rot || 0, holes[it.i].hrot || 0);
                    else if (!S.noGuides) {
                        c.save(); c.setLineDash([6, 5]); c.strokeStyle = P.fg;
                        c.strokeRect(fx, cy - it.fh / 2, it.fw, it.fh); c.restore();
                    }
                    if (it.after !== undefined) S.hits.push({ kind: 'sslot', i: it.after, x, y, w: it.w, h: l.lh });
                } else if (it.pend) {
                    c.fillStyle = P.fg; c.fillText(it.t, x, cy);
                    if (!S.noGuides) { c.save(); c.setLineDash([6, 5]); c.strokeStyle = '#3b9bff'; c.lineWidth = 2; c.strokeRect(x, cy - fs * 0.6, it.w, fs * 1.2); c.restore(); }
                    S.hits.push({ kind: 'sslot', i: it.after, x, y, w: it.w, h: l.lh });
                } else {
                    c.fillStyle = P.fg; c.fillText(it.t, x, cy);
                    S.hits.push({ kind: 'stok', i: it.ti, x, y, w: it.w, h: l.lh });
                }
                x += it.w;
            });
            y += l.lh;
        });
    }

    /* ---------- 通用：点选 / 拖动连选 ---------- */
    function paintDown(kind, set, x, y) {
        const h = S.hits.find(h => h.kind === kind && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
        if (!h) return false;
        const val = !set.has(h.i);
        val ? set.add(h.i) : set.delete(h.i);
        S.drag = { paint: true, val, kind, set };
        return true;
    }
    function paintMove(x, y) {
        const d = S.drag;
        if (!d || !d.paint) return false;
        const h = S.hits.find(h => h.kind === d.kind && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
        if (!h || d.set.has(h.i) === d.val) return false;
        d.val ? d.set.add(h.i) : d.set.delete(h.i);
        return true;
    }

    /* =====================================================
     * 模板 2：涂黑诗
     * ===================================================== */
    const blackout = {
        id: 'blackout',
        name: '涂黑诗',
        hint: '点词语：留下/再涂黑；手指划过可连选。黑块只出现在留字的范围内，上下没留字的行显示成淡灰色（仅供点选，导出时不会出现）。',
        defaults: { gran: 'char', fontSize: 3.6, font: 'theme', paper: '#f4efdc', ink: '#111111' },
        controls: [
            { group: '点选', key: 'gran', label: '点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词(中文自动分词)']], onChange() { S.keep = null; } },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.8, max: 7, step: 0.1 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '颜色', key: 'paper', label: '纸色', type: 'color' },
            { group: '颜色', key: 'ink', label: '墨色', type: 'color' },
        ],
        exportOk() { return !!(S.keep && S.keep.set.size); },
        exportMsg: '还没有留下任何字，先点几个词吧',
        snap() { return JSON.stringify([...(S.keep ? S.keep.set : [])]); },
        restore(str) { S.keep = { set: new Set(JSON.parse(str)) }; },
        clear() { S.keep = { set: new Set() }; },
        render(cv, c, P) {
            S.keep ??= { set: new Set() };
            const W = 1000, M = 80;
            const fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
            mctx.font = `${fs}px ${fam}`;
            const toks = tokenize((S.text || '').trim() || SAMPLE, P.gran);
            const spaceW = mctx.measureText(' ').width;
            const items = toks.map((tk, i) => tk.nl ? { nl: true, w: 0 } : { i, t: tk.t, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
            const lines = wrap(items, W - M * 2);
            const lh = fs * 1.7;
            const hasKept = lines.map(l => l.items.some(it => !it.nl && S.keep.set.has(it.i)));
            const f = hasKept.indexOf(true), e = hasKept.lastIndexOf(true), any = f >= 0;
            const guides = !S.noGuides;
            const from = (any && !guides) ? f : 0;
            const to = (any && !guides) ? e : lines.length - 1;
            const rows = !any && !guides ? 1 : to - from + 1;
            const blockLines = any ? lines.slice(f, e + 1) : lines;
            const blockW = Math.max(1, ...blockLines.map(l => l.w));
            cv.width = W; cv.height = Math.round(M * 2 + rows * lh);
            c.fillStyle = P.paper; c.fillRect(0, 0, W, cv.height);
            if (any) { c.fillStyle = P.ink; c.fillRect(M, M + (f - from) * lh, blockW, (e - f + 1) * lh); }   // 一整块，没有缝
            c.font = `${fs}px ${fam}`; c.textBaseline = 'middle';
            for (let li = from; li <= to && li < lines.length; li++) {
                const y = M + (li - from) * lh;
                const inBlock = any && li >= f && li <= e;
                const real = lines[li].items.filter(it => !it.nl);
                let x = M;
                const pos = real.map(it => { const p = { it, x }; x += it.w; return p; });
                let a = 0;
                while (a < pos.length) {
                    const kept = S.keep.set.has(pos[a].it.i);
                    let b = a;
                    while (b + 1 < pos.length && S.keep.set.has(pos[b + 1].it.i) === kept) b++;
                    if (kept) {
                        const x0 = pos[a].x, x1 = pos[b].x + pos[b].it.w;
                        c.fillStyle = P.paper; c.fillRect(x0, y + lh * 0.1, x1 - x0, lh * 0.8);
                        c.fillStyle = P.ink;
                        for (let k = a; k <= b; k++) c.fillText(pos[k].it.t, pos[k].x, y + lh / 2);
                    } else if (!inBlock && guides) {
                        c.fillStyle = 'rgba(120,120,120,.55)';
                        for (let k = a; k <= b; k++) c.fillText(pos[k].it.t, pos[k].x, y + lh / 2);
                    }
                    a = b + 1;
                }
                pos.forEach(p => S.hits.push({ kind: 'tok', i: p.it.i, x: p.x, y, w: p.it.w, h: lh }));
            }
        },
        onDown(x, y) { S.keep ??= { set: new Set() }; return paintDown('tok', S.keep.set, x, y); },
        onMove: paintMove,
        onUp() { S.drag = null; },
    };

    /* =====================================================
     * 模板 3：验证码九宫格
     * ===================================================== */
    const captcha = {
        id: 'captcha',
        name: '验证码九宫格',
        hint: '点格子：选中/取消；手指划过可连选。标题留空则取选中的文字。',
        defaults: { cols: 4, rows: 4, gap: 8, title: '', sub: 'If there are none, click skip', blue: '#2f77e8' },
        controls: [
            { group: '文字', key: 'title', label: '大标题(留空=选中文字)', type: 'text' },
            { group: '文字', key: 'sub', label: '副标题', type: 'text' },
            { group: '网格', key: 'cols', label: '列数', type: 'range', min: 2, max: 8, step: 1, onChange() { S.cells = null; } },
            { group: '网格', key: 'rows', label: '行数', type: 'range', min: 2, max: 8, step: 1, onChange() { S.cells = null; } },
            { group: '网格', key: 'gap', label: '格间距', type: 'range', min: 0, max: 20, step: 1 },
            { group: '颜色', key: 'blue', label: '主色', type: 'color' },
        ],
        snap() { return JSON.stringify([...(S.cells ? S.cells.set : [])]); },
        restore(str) { S.cells = { set: new Set(JSON.parse(str)) }; },
        clear() { S.cells = { set: new Set() }; },
        render(cv, c, P) {
            S.cells ??= { set: new Set() };
            const img = S.img, W = 1000, pad = 40, gap = P.gap, cols = P.cols, rows = P.rows;
            const gw = W - pad * 2, cw = (gw - gap * (cols - 1)) / cols, gh = rows * cw + gap * (rows - 1);
            const headH = 280, footH = 170, y0 = pad + headH + gap, footY = y0 + gh + gap;
            cv.width = W; cv.height = Math.round(footY + footH);
            c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, W, cv.height);
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
        onDown(x, y) { S.cells ??= { set: new Set() }; return paintDown('cell', S.cells.set, x, y); },
        onMove: paintMove,
        onUp() { S.drag = null; },
    };


    /* =====================================================
     * 模板 4：文字塑形（多种排字方式）
     * ===================================================== */
    function shapePlace(x, y, P, ui2) {
        const F = P.frame, IH = Math.round(1200 * imgH(S.img) / imgW(S.img));
        const fx = clamp((x - F) / 1200 * 100, 0, 100), fy = clamp((y - F) / IH * 100, 0, 100);
        if (P.mode === 'shape' || P.mode === 'ring') { ui2.setParam('sx', Math.round(fx)); ui2.setParam('sy', Math.round(fy)); }
        else if (P.mode === 'wave') ui2.setParam('waveY', Math.round(fy));
        else ui2.setParam('zone', Math.round(clamp(fx, 0, 95)));
    }
    function textRegion(c, P, T, IW, IH) {
        let data = null;
        try {
            const t = document.createElement('canvas'); t.width = IW; t.height = IH;
            const tc = t.getContext('2d'); tc.drawImage(S.img, 0, 0, IW, IH);
            data = tc.getImageData(0, 0, IW, IH).data;
        } catch (e) { data = null; }
        const zoneX = Math.floor(IW * P.zone / 100), { fs, lh } = T;
        const ok = (x, y) => {
            if (!data) return true;
            const i = ((y | 0) * IW + (x | 0)) * 4;
            const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            return P.invert ? l >= P.thr : l <= P.thr;
        };
        const sp = T.hasSp ? T.spaceW : 0;
        for (let y = 0; y + lh <= IH; y += lh) {
            const ys = [y + lh * 0.2, y + lh * 0.5, y + lh * 0.8].map(v => clamp(v, 0, IH - 1));
            let best = null, start = -1, gap = 0, last = -1;
            const take = () => { const seg = { a: start, b: last + 4 }; if (!best || seg.b - seg.a > best.b - best.a) best = seg; };
            for (let x = zoneX; x < IW; x += 4) {
                if (ys.every(yy => ok(x, yy))) { if (start < 0) start = x; last = x; gap = 0; }
                else if (start >= 0 && ++gap > 2) { take(); start = -1; gap = 0; }
            }
            if (start >= 0) take();
            if (!best) continue;
            const avail = best.b - best.a - fs * 0.2;
            if (avail < fs * 2) continue;
            const picks = [];
            let sum = 0;
            while (picks.length < 80) {
                const k = (T.cursor + picks.length) % T.units.length;
                const add = (picks.length ? sp : 0) + T.widths[k];
                if (sum + add > avail) break;
                sum += add; picks.push(k);
            }
            if (!picks.length) continue;
            T.cursor = (T.cursor + picks.length) % T.units.length;
            const total = picks.reduce((s0, k) => s0 + T.widths[k], 0);
            let gapW = sp, x0 = best.a + fs * 0.1;
            if (P.align === 'justify' && picks.length > 1) gapW = (avail - total) / (picks.length - 1);
            else {
                const used = total + gapW * (picks.length - 1);
                if (P.align === 'right') x0 = best.b - fs * 0.1 - used;
                else if (P.align === 'center') x0 = best.a + (avail - used) / 2;
            }
            let x = x0;
            picks.forEach(k => { c.fillText(T.units[k], x, y + lh / 2); x += T.widths[k] + gapW; });
        }
    }
    function textInShape(c, P, T, IW, IH) {
        const sw = IW * P.shapeSize / 100, sh = sw * shapeRatio({ shape: P.tshape, aspect: P.shapeAspect });
        const cx = IW * P.sx / 100, cy = IH * P.sy / 100, sp = T.hasSp ? T.spaceW : 0;
        c.save();
        pathShape(c, P.tshape, cx, cy, sw, sh);
        if (P.fillOn) { c.fillStyle = P.shapeFill; c.fill(); }
        c.clip();
        c.fillStyle = P.color;
        for (let y = cy - sh / 2 + T.lh * 0.5; y < cy + sh / 2 + T.lh; y += T.lh) {
            let x = cx - sw / 2 - T.fs;
            while (x < cx + sw / 2 + T.fs) {
                const k = T.cursor % T.units.length;
                c.fillText(T.units[k], x, y);
                x += T.widths[k] + sp; T.cursor++;
            }
        }
        c.restore();
    }
    function drawAlong(c, pts, T) {
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const total = cum[cum.length - 1], sp = T.hasSp ? T.spaceW : 0;
        let s0 = 0, seg = 1;
        while (s0 < total) {
            const k = T.cursor % T.units.length, w = T.widths[k], mid = s0 + w / 2;
            if (mid > total) break;
            while (seg < cum.length - 1 && cum[seg] < mid) seg++;
            const t = (mid - cum[seg - 1]) / Math.max(1e-6, cum[seg] - cum[seg - 1]);
            const x = pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * t, y = pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * t;
            const ang = Math.atan2(pts[seg][1] - pts[seg - 1][1], pts[seg][0] - pts[seg - 1][0]);
            c.save(); c.translate(x, y); c.rotate(ang); c.textAlign = 'center'; c.fillText(T.units[k], 0, 0); c.restore();
            s0 += w + sp; T.cursor++;
        }
    }
    function textWave(c, P, T, IW, IH) {
        const A = IH * P.amp / 100, L = Math.max(40, IW * P.wl / 100), n = P.waveN;
        for (let k = 0; k < n; k++) {
            const y0 = IH * P.waveY / 100 + (k - (n - 1) / 2) * T.lh * 1.25;
            const pts = [];
            for (let x = -40; x <= IW + 40; x += 3) pts.push([x, y0 + A * Math.sin(2 * Math.PI * x / L)]);
            drawAlong(c, pts, T);
        }
    }
    function textRing(c, P, T, IW, IH) {
        const cx = IW * P.sx / 100, cy = IH * P.sy / 100, R = IW * P.shapeSize / 200, rMin = Math.max(T.fs * 1.2, 4);
        const gapW = T.hasSp ? T.spaceW : 0;
        const put = (k, ang, r) => {
            c.save(); c.translate(cx + r * Math.cos(ang), cy + r * Math.sin(ang)); c.rotate(ang + Math.PI / 2);
            c.textAlign = 'center'; c.fillText(T.units[k], 0, 0); c.restore();
        };
        if (P.ringType === 'rings') {
            for (let r = R; r > rMin; r -= T.lh) {
                const circ = 2 * Math.PI * r, picks = [];
                let sum = 0;
                while (picks.length < 400) {
                    const k = (T.cursor + picks.length) % T.units.length, add = T.widths[k] + gapW;
                    if (sum + add > circ) break;
                    sum += add; picks.push(k);
                }
                if (!picks.length) break;
                T.cursor = (T.cursor + picks.length) % T.units.length;
                const extra = (circ - sum) / picks.length;
                let s0 = 0;
                picks.forEach(k => { const w = T.widths[k]; put(k, -Math.PI / 2 + (s0 + w / 2) / r, r); s0 += w + gapW + extra; });
            }
        } else {
            let ang = -Math.PI / 2, r = R;
            const b = T.lh / (2 * Math.PI);
            for (let it = 0; it < 6000 && r > rMin; it++) {
                const k = T.cursor % T.units.length, w = T.widths[k] + gapW, dth = w / r;
                put(k, ang + dth / 2, r - b * dth / 2);
                ang += dth; r -= b * dth; T.cursor++;
            }
        }
    }
    function textVertical(c, P, T, IW, IH) {
        const zoneX = IW * P.zone / 100, col = T.lh, step = T.fs * 1.08;
        for (let x = IW - col / 2; x > zoneX; x -= col) {
            let y = T.fs * 0.6;
            while (y < IH - T.fs * 0.3) {
                const k = T.cursor % T.units.length;
                if (T.hasSp) {
                    const w = T.widths[k];
                    c.save(); c.translate(x, y + w / 2); c.rotate(Math.PI / 2); c.textAlign = 'center'; c.fillText(T.units[k], 0, 0); c.restore();
                    y += w + T.spaceW;
                } else {
                    c.save(); c.textAlign = 'center'; c.fillText(T.units[k], x, y + step / 2); c.restore();
                    y += step;
                }
                T.cursor++;
            }
        }
    }
    const shape = {
        id: 'shape',
        name: '文字塑形',
        hint(P) {
            return ({
                region: '文字沿着画面里「暗色」的区域排布，亮色区域留空。在图上点一下，设置文字区域的左边界。',
                shape: '文字填满一个形状。点图或拖动，可以移动形状的位置。',
                wave: '文字沿着波浪线排布。点图或拖动，可以上下移动波浪。',
                ring: '文字绕成圆环或螺旋。点图或拖动，可以移动圆心。',
                vertical: '文字竖排，从右往左。点图可以设置竖排区域的左边界。',
            })[P.mode] || '';
        },
        defaults: {
            mode: 'region', zone: 40, thr: 140, invert: false, align: 'justify',
            tshape: 'circle', shapeAspect: 1, shapeSize: 60, sx: 50, sy: 50, fillOn: true, shapeFill: '#141414', ringType: 'spiral',
            waveN: 4, amp: 12, wl: 50, waveY: 50,
            fontSize: 2.3, lineGap: 1.3, upper: true, font: 'theme', color: '#f3dcc8', caption: '', dim: 10, frame: 60, frameColor: '#000000', grain: 0,
        },
        controls: [
            { group: '排字方式', key: 'mode', label: '类型', type: 'select', options: [['region', '沿画面暗/亮区域'], ['shape', '填满一个形状'], ['wave', '走成波浪线'], ['ring', '绕成圆环 / 螺旋'], ['vertical', '竖排（从右往左）']] },
            { group: '排布', key: 'zone', label: '文字区域左边界 %', type: 'range', min: 0, max: 95, step: 1, show: P => P.mode === 'region' || P.mode === 'vertical' },
            { group: '排布', key: 'thr', label: '亮度阈值', type: 'range', min: 20, max: 240, step: 1, show: P => P.mode === 'region' },
            { group: '排布', key: 'invert', label: '反转（改在亮色区排字）', type: 'checkbox', show: P => P.mode === 'region' },
            { group: '排布', key: 'align', label: '对齐方式', type: 'select', options: [['justify', '两端撑满'], ['left', '靠左'], ['right', '靠右'], ['center', '居中']], show: P => P.mode === 'region' },
            { group: '形状', key: 'tshape', label: '形状', type: 'select', options: SHAPE_OPTS, show: P => P.mode === 'shape' },
            { group: '形状', key: 'shapeAspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1, show: P => P.mode === 'shape' && (P.tshape === 'rect' || P.tshape === 'ellipse') },
            { group: '形状', key: 'shapeSize', label: '大小 %', type: 'range', min: 10, max: 100, step: 1, show: P => P.mode === 'shape' || P.mode === 'ring' },
            { group: '形状', key: 'fillOn', label: '形状里垫一层底色', type: 'checkbox', show: P => P.mode === 'shape' },
            { group: '形状', key: 'shapeFill', label: '底色', type: 'color', show: P => P.mode === 'shape' && P.fillOn },
            { group: '形状', key: 'ringType', label: '环的样式', type: 'select', options: [['spiral', '螺旋'], ['rings', '同心圆环']], show: P => P.mode === 'ring' },
            { group: '形状', key: 'drawShape', label: '手绘一个自定义形状', type: 'button', noUndo: true, show: P => P.mode === 'shape', onClick() { ui.openShapePad(); } },
            { group: '形状', key: 'imgShape', label: '用图片做形状', type: 'button', noUndo: true, show: P => P.mode === 'shape', onClick() { ui.pickShapeImage(); } },
            { group: '形状', key: 'delShape', label: '删除这个自定义形状', type: 'button', noUndo: true, show: P => P.mode === 'shape' && String(P.tshape).startsWith('custom:'), onClick(P) { ui.deleteCustomShape(P.tshape); } },
            { group: '波浪', key: 'waveN', label: '几行', type: 'range', min: 1, max: 12, step: 1, show: P => P.mode === 'wave' },
            { group: '波浪', key: 'amp', label: '起伏高度 %', type: 'range', min: 2, max: 40, step: 1, show: P => P.mode === 'wave' },
            { group: '波浪', key: 'wl', label: '波长 %', type: 'range', min: 15, max: 120, step: 1, show: P => P.mode === 'wave' },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.2, max: 5, step: 0.1 },
            { group: '文字', key: 'lineGap', label: '行距', type: 'range', min: 1, max: 2, step: 0.05 },
            { group: '文字', key: 'upper', label: '英文转大写', type: 'checkbox' },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '文字', key: 'caption', label: '左上角小标题（空格分词，逐行错开）', type: 'text' },
            { group: '画面', key: 'dim', label: '压暗图片 %', type: 'range', min: 0, max: 70, step: 1 },
            { group: '画面', key: 'frame', label: '边框宽度', type: 'range', min: 0, max: 150, step: 2 },
            { group: '颜色', key: 'color', label: '文字颜色', type: 'color' },
            { group: '颜色', key: 'frameColor', label: '边框颜色', type: 'color' },
            { group: '质感', key: 'grain', label: '颗粒感 %', type: 'range', min: 0, max: 100, step: 5 },
        ],
        render(cv, c, P) {
            const img = S.img, IW = 1200, IH = Math.round(IW * imgH(img) / imgW(img)), F = P.frame;
            cv.width = IW + F * 2; cv.height = IH + F * 2;
            c.fillStyle = P.frameColor; c.fillRect(0, 0, cv.width, cv.height);
            c.drawImage(img, F, F, IW, IH);
            if (P.dim > 0) { c.fillStyle = `rgba(0,0,0,${P.dim / 100})`; c.fillRect(F, F, IW, IH); }
            const fam = fontFamily(P.font), fs = Math.round(IW * P.fontSize / 100), lh = fs * P.lineGap;
            c.font = `bold ${fs}px ${fam}`; mctx.font = c.font;
            const raw = ((S.text || '').trim() || SAMPLE).replace(/\s*\n\s*/g, ' ');
            const hasSp = /\s/.test(raw);
            let units = hasSp ? raw.split(/\s+/) : [...raw];
            if (P.upper) units = units.map(w => w.toUpperCase());
            const T = { units, widths: units.map(w => mctx.measureText(w).width), spaceW: hasSp ? mctx.measureText(' ').width : 0, hasSp, cursor: 0, fs, lh };
            c.save();
            c.translate(F, F); c.beginPath(); c.rect(0, 0, IW, IH); c.clip();
            c.fillStyle = P.color; c.textBaseline = 'middle'; c.textAlign = 'left'; c.font = `bold ${fs}px ${fam}`;
            if (P.mode === 'shape') textInShape(c, P, T, IW, IH);
            else if (P.mode === 'wave') textWave(c, P, T, IW, IH);
            else if (P.mode === 'ring') textRing(c, P, T, IW, IH);
            else if (P.mode === 'vertical') textVertical(c, P, T, IW, IH);
            else textRegion(c, P, T, IW, IH);
            c.restore();
            if (P.caption.trim()) {
                const cf = Math.round(IW * 0.016);
                c.font = `bold ${cf}px ${fam}`; c.fillStyle = P.color; c.textBaseline = 'middle'; c.textAlign = 'left';
                P.caption.trim().split(/\s+/).forEach((w, i) => c.fillText(P.upper ? w.toUpperCase() : w, F + IW * 0.07 + i * IW * 0.035, F + IH * 0.1 + i * cf * 1.5));
            }
            applyGrain(c, cv.width, cv.height, P.grain);
        },
        onDown(x, y, P, ui2) { shapePlace(x, y, P, ui2); S.drag = { place: true }; return true; },
        onMove(x, y, P, ui2) { if (!S.drag || !S.drag.place) return false; shapePlace(x, y, P, ui2); return true; },
        onUp() { S.drag = null; },
    };

    /* =====================================================
     * 模板 6：切边时间表
     * ===================================================== */
    const timeline = {
        id: 'timeline',
        name: '切边时间表',
        hint: '每一行文字占一个色块，空行 = 空白色块。在图上左右拖动，可调整那一行切进画面的深度。',
        defaults: { ratio: '3:2', bands: 20, startBand: 1, jag: 50, fontSize: 1.7, font: 'theme', title: '', footer: '', panel: '#bfc0b8', ink: '#111111', grain: 0 },
        controls: [
            { group: '版面', key: 'ratio', label: '画面比例', type: 'select', options: RATIO_OPTS },
            { group: '版面', key: 'bands', label: '色块行数', type: 'range', min: 8, max: 40, step: 1 },
            { group: '版面', key: 'startBand', label: '文字从第几行开始', type: 'range', min: 0, max: 12, step: 1 },
            { group: '版面', key: 'jag', label: '默认错落程度', type: 'range', min: 0, max: 100, step: 5 },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1, max: 3.5, step: 0.1 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '文字', key: 'title', label: '右上角大标题', type: 'text' },
            { group: '文字', key: 'footer', label: '右下角小字（换行用 / ）', type: 'text' },
            { group: '颜色', key: 'panel', label: '色块颜色', type: 'color' },
            { group: '颜色', key: 'ink', label: '文字颜色', type: 'color' },
            { group: '质感', key: 'grain', label: '颗粒感 %', type: 'range', min: 0, max: 100, step: 5 },
        ],
        snap() { return JSON.stringify(S.edges); },
        restore(str) { S.edges = JSON.parse(str); },
        clear() { S.edges = {}; },
        render(cv, c, P) {
            const [rw, rh] = RATIOS[P.ratio] || [3, 2], W = 1200, H = Math.round(W * rh / rw);
            cv.width = W; cv.height = H;
            drawCover(c, S.img, 0, 0, W, H);
            const nb = P.bands, bh = H / nb, fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
            const lines = textLines(SAMPLE_TIMELINE);
            const padX = fs * 0.9;
            S.tl = { bh, nb, W };
            c.textBaseline = 'middle'; c.textAlign = 'left';
            for (let b = 0; b < nb; b++) {
                const li = b - P.startBand;
                const txt = (li >= 0 && li < lines.length) ? lines[li] : '';
                const parts = txt ? txt.split(/\s{2,}|\t/) : [];
                let w1 = 0, w2 = 0;
                const colGap = fs * 1.2;
                if (txt) {
                    mctx.font = `bold ${fs}px ${fam}`; w1 = mctx.measureText(parts[0]).width;
                    if (parts.length > 1) { mctx.font = `${fs}px ${fam}`; w2 = mctx.measureText(parts.slice(1).join(' ')).width; }
                }
                const tw = w1 + (parts.length > 1 ? colGap + w2 : 0);
                let edge = W * clamp(0.5 + P.jag / 100 * 0.2 * (hash(b + 1) * 2 - 1), 0.1, 0.92);
                if (S.edges[b] !== undefined) edge = S.edges[b] * W;
                if (txt) edge = Math.min(edge, W - tw - padX * 2 - W * 0.02);
                c.fillStyle = P.panel;
                c.fillRect(Math.round(edge), Math.floor(b * bh), W - Math.round(edge) + 1, Math.ceil(bh) + 1);
                if (txt) {
                    c.fillStyle = P.ink;
                    c.font = `bold ${fs}px ${fam}`; c.fillText(parts[0], edge + padX, b * bh + bh / 2);
                    if (parts.length > 1) { c.font = `${fs}px ${fam}`; c.fillText(parts.slice(1).join(' '), edge + padX + w1 + colGap, b * bh + bh / 2); }
                }
            }
            if (P.title.trim()) {
                const tf = Math.round(W * 0.05);
                c.font = `900 ${tf}px ${fam}`;
                const tw = c.measureText(P.title).width;
                c.fillStyle = P.panel; c.fillRect(W - tw - W * 0.06, 0, tw + W * 0.06, tf * 1.6);
                c.fillStyle = P.ink; c.textAlign = 'right'; c.fillText(P.title, W - W * 0.03, tf * 0.95); c.textAlign = 'left';
            }
            if (P.footer.trim()) {
                const ff = Math.round(W * 0.012), fl = P.footer.split('/').map(t => t.trim());
                c.font = `bold ${ff}px ${fam}`;
                const fw = Math.max(...fl.map(t => c.measureText(t).width));
                c.fillStyle = P.panel; c.fillRect(W - fw - W * 0.06, H - fl.length * ff * 1.5 - W * 0.03, fw + W * 0.06, fl.length * ff * 1.5 + W * 0.03);
                c.fillStyle = P.ink; c.textAlign = 'right';
                fl.forEach((t, i) => c.fillText(t, W - W * 0.03, H - W * 0.02 - (fl.length - 1 - i) * ff * 1.5));
                c.textAlign = 'left';
            }
            applyGrain(c, W, H, P.grain);
        },
        onDown(x, y) { const t = S.tl; if (!t) return false; setEdge(x, y); S.drag = { edge: true }; return true; },
        onMove(x, y) { if (!S.drag || !S.drag.edge) return false; setEdge(x, y); return true; },
        onUp() { S.drag = null; },
    };
    function setEdge(x, y) {
        const t = S.tl;
        const b = clamp(Math.floor(y / t.bh), 0, t.nb - 1);
        S.edges[b] = clamp(x / t.W, 0.05, 0.97);
    }

    /* =====================================================
     * 模板 7：检测框关系图
     * ===================================================== */
    const detect = {
        id: 'detect',
        name: '检测框关系图',
        hint: '在上方图片上拖出方框（点一下方框可删除）。第1行文字标在图上，第2行文字放在下方色块区。',
        defaults: { k: 2, cropScale: 1, panelH: 100, fontSize: 2.4, font: 'theme', labels: true, box: '#2f5be8', label: '#1d4ed8', panel: '#1250e8', lineColor: '#ffffff' },
        controls: [
            { group: '关系图', key: 'k', label: '每个方块连向最近的几个', type: 'range', min: 0, max: 4, step: 1 },
            { group: '关系图', key: 'cropScale', label: '碎片缩放', type: 'range', min: 0.4, max: 2, step: 0.1 },
            { group: '关系图', key: 'panelH', label: '下方区域高度 %', type: 'range', min: 50, max: 140, step: 5 },
            { group: '文字', key: 'labels', label: '显示文字标签', type: 'checkbox' },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.2, max: 5, step: 0.1 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '颜色', key: 'box', label: '方框颜色', type: 'color' },
            { group: '颜色', key: 'label', label: '图上文字颜色', type: 'color' },
            { group: '颜色', key: 'panel', label: '下方底色', type: 'color' },
            { group: '颜色', key: 'lineColor', label: '连线/下方文字色', type: 'color' },
        ],
        exportOk() { return S.boxes.length > 0; },
        exportMsg: '还没有画方框，先在图上拖出几个吧',
        snap() { return JSON.stringify(S.boxes); },
        restore(str) { S.boxes = JSON.parse(str); },
        clear() { S.boxes = []; },
        render(cv, c, P) {
            const img = S.img, W = 1200, IW = W, IH = Math.round(W * imgH(img) / imgW(img)), PH = Math.round(IH * P.panelH / 100);
            cv.width = W; cv.height = IH + PH;
            c.drawImage(img, 0, 0, IW, IH);
            c.fillStyle = P.panel; c.fillRect(0, IH, W, PH);
            S.det = { IW, IH, PH };
            const boxes = S.boxes;
            c.lineWidth = 3; c.strokeStyle = P.box;
            boxes.forEach(b => c.strokeRect(b.x0 * IW, b.y0 * IH, (b.x1 - b.x0) * IW, (b.y1 - b.y0) * IH));
            if (!S.noGuides && S.tmpBox) {
                const b = S.tmpBox;
                c.save(); c.setLineDash([8, 6]); c.strokeRect(b.x0 * IW, b.y0 * IH, (b.x1 - b.x0) * IW, (b.y1 - b.y0) * IH); c.restore();
            }
            // 下方关系图
            const pts = boxes.map(b => ({ x: (b.x0 + b.x1) / 2 * IW, y: IH + (b.y0 + b.y1) / 2 * PH, w: (b.x1 - b.x0) * IW * P.cropScale, h: (b.y1 - b.y0) * IH * P.cropScale, b }));
            const pairs = new Set();
            pts.forEach((p, i) => {
                pts.map((q, j) => ({ j, d: Math.hypot(p.x - q.x, p.y - q.y) })).filter(o => o.j !== i)
                    .sort((a, b) => a.d - b.d).slice(0, P.k).forEach(o => pairs.add(Math.min(i, o.j) + '-' + Math.max(i, o.j)));
            });
            c.strokeStyle = P.lineColor; c.lineWidth = 2; c.globalAlpha = 0.85;
            pairs.forEach(k => { const [a, b] = k.split('-').map(Number); c.beginPath(); c.moveTo(pts[a].x, pts[a].y); c.lineTo(pts[b].x, pts[b].y); c.stroke(); });
            c.globalAlpha = 1;
            pts.forEach(p => {
                c.fillStyle = '#fff'; c.fillRect(p.x - p.w / 2 - 3, p.y - p.h / 2 - 3, p.w + 6, p.h + 6);
                c.drawImage(img, p.b.x0 * imgW(img), p.b.y0 * imgH(img), (p.b.x1 - p.b.x0) * imgW(img), (p.b.y1 - p.b.y0) * imgH(img), p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
            });
            // 文字标签
            if (P.labels) {
                const lines = textLines(SAMPLE_DETECT), fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
                const L1 = unitsOf(lines[0] || ''), L2 = unitsOf(lines[1] || '');
                c.textBaseline = 'middle'; c.textAlign = 'left';
                const put = (i, w, x, y, color) => {
                    const num = `(${i + 1}) `;
                    c.font = `${fs}px ${fam}`; const nw = c.measureText(num).width;
                    c.font = `bold ${fs}px ${fam}`; const ww = c.measureText(w).width;
                    const xx = clamp(x, 10, IW - nw - ww - 10);
                    c.fillStyle = color; c.font = `${fs}px ${fam}`; c.fillText(num, xx, y);
                    c.font = `bold ${fs}px ${fam}`; c.fillText(w, xx + nw, y);
                };
                L1.forEach((w, i) => { const t = L1.length > 1 ? i / (L1.length - 1) : 0; put(i, w, IW * 0.1 + t * IW * 0.62, IH * 0.15 + t * IH * 0.6, P.label); });
                const zy = [0.1, 0.3, 0.06, 0.5, 0.88, 0.28, 0.92];
                L2.forEach((w, i) => { const t = L2.length > 1 ? i / (L2.length - 1) : 0.5; put(i, w, IW * (0.06 + 0.8 * t), IH + PH * zy[i % zy.length], P.lineColor); });
            }
        },
        onDown(x, y) {
            const d = S.det;
            if (!d || x < 0 || x > d.IW || y < 0 || y > d.IH) return false;
            const fx = x / d.IW, fy = y / d.IH;
            let hit = -1;
            for (let k = S.boxes.length - 1; k >= 0; k--) {
                const b = S.boxes[k];
                if (fx >= b.x0 && fx <= b.x1 && fy >= b.y0 && fy <= b.y1) { hit = k; break; }
            }
            S.drag = { box: true, x0: fx, y0: fy, hit, moved: false };
            S.tmpBox = null;
            return true;
        },
        onMove(x, y) {
            const dr = S.drag, d = S.det;
            if (!dr || !dr.box || !d) return false;
            const fx = clamp(x / d.IW, 0, 1), fy = clamp(y / d.IH, 0, 1);
            if (Math.abs(fx - dr.x0) * d.IW > 8 || Math.abs(fy - dr.y0) * d.IH > 8) dr.moved = true;
            if (dr.moved) S.tmpBox = { x0: Math.min(dr.x0, fx), y0: Math.min(dr.y0, fy), x1: Math.max(dr.x0, fx), y1: Math.max(dr.y0, fy) };
            return true;
        },
        onUp() {
            const dr = S.drag, d = S.det;
            if (dr && dr.box && d) {
                const b = S.tmpBox;
                if (!dr.moved && dr.hit >= 0) S.boxes.splice(dr.hit, 1);
                else if (b && (b.x1 - b.x0) * d.IW > 10 && (b.y1 - b.y0) * d.IH > 10) S.boxes.push(b);
            }
            S.tmpBox = null; S.drag = null;
        },
    };

    /* =====================================================
     * 模板 8：图版标注
     * ===================================================== */
    const board = {
        id: 'board',
        name: '图版标注',
        hint: '第1行 = 标题，第2行 = 说明，之后每一行是一条图例（自动编罗马数字，分布在图的上下两侧）。',
        defaults: { ratio: '3:2', imgW: 66, fontSize: 1.15, font: 'theme', tick: true, bg: '#ffffff', ink: '#222222' },
        controls: [
            { group: '版面', key: 'ratio', label: '画面比例', type: 'select', options: RATIO_OPTS },
            { group: '版面', key: 'imgW', label: '图片区域宽度 %', type: 'range', min: 40, max: 85, step: 1 },
            { group: '版面', key: 'tick', label: '显示小刻度线', type: 'checkbox' },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 0.8, max: 2.2, step: 0.05 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '颜色', key: 'bg', label: '背景色', type: 'color' },
            { group: '颜色', key: 'ink', label: '文字颜色', type: 'color' },
        ],
        render(cv, c, P) {
            const img = S.img, [rw, rh] = RATIOS[P.ratio] || [3, 2], W = 1500, H = Math.round(W * rh / rw);
            cv.width = W; cv.height = H;
            c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
            const fam = fontFamily(P.font), fs = Math.round(W * P.fontSize / 100);
            const M = W * 0.035, areaW = W * P.imgW / 100, areaX = W - M - areaW, areaTop = H * 0.12, areaH = H * 0.76;
            const sc = Math.min(areaW / imgW(img), areaH / imgH(img));
            const dw = imgW(img) * sc, dh = imgH(img) * sc, dx = areaX + (areaW - dw) / 2, dy = areaTop + (areaH - dh) / 2;
            c.drawImage(img, dx, dy, dw, dh);
            const lines = textLines(SAMPLE_BOARD);
            const title = lines[0] || '', desc = lines[1] || '', entries = lines.slice(2).filter(Boolean);
            const n = entries.length, topN = Math.ceil(n / 2), botN = n - topN;
            c.fillStyle = P.ink; c.strokeStyle = P.ink; c.lineWidth = 1.2;
            c.textBaseline = 'middle'; c.textAlign = 'center'; c.font = `${fs * 0.85}px ${fam}`;
            for (let i = 0; i < topN; i++) {
                const x = dx + dw * (i + 0.5) / topN;
                c.fillText(romanize(i + 1), x, dy - fs * 1.7);
                if (P.tick) { c.beginPath(); c.moveTo(x, dy - fs * 0.9); c.lineTo(x, dy - fs * 0.2); c.stroke(); }
            }
            for (let j = 0; j < botN; j++) {
                const x = dx + dw * (j + 0.5) / botN;
                c.fillText(romanize(topN + j + 1), x, dy + dh + fs * 1.7);
                if (P.tick) { c.beginPath(); c.moveTo(x, dy + dh + fs * 0.9); c.lineTo(x, dy + dh + fs * 0.2); c.stroke(); }
            }
            c.textAlign = 'left';
            const colW = Math.max(80, areaX - M * 2) * 0.92, x0 = M;
            const flow = (k, draw) => {
                let y = H * 0.08;
                const f1 = fs * k, f2 = fs * 0.9 * k;
                if (title) {
                    mctx.font = `${f1}px ${fam}`; c.font = mctx.font;
                    if (draw && 'letterSpacing' in c) c.letterSpacing = (f1 * 0.08) + 'px';
                    textBlock(title.toUpperCase(), colW).forEach(t => { if (draw) c.fillText(t, x0, y); y += f1 * 1.5; });
                    if ('letterSpacing' in c) c.letterSpacing = '0px';
                }
                if (desc) {
                    y = Math.max(y + f2 * 2, H * 0.3);
                    mctx.font = `${f2}px ${fam}`; c.font = mctx.font;
                    if (draw && 'letterSpacing' in c) c.letterSpacing = (f2 * 0.06) + 'px';
                    textBlock(desc.toUpperCase(), colW).forEach(t => { if (draw) c.fillText(t, x0, y); y += f2 * 1.6; });
                    if ('letterSpacing' in c) c.letterSpacing = '0px';
                }
                if (entries.length) {
                    y += f2 * 1.2;
                    mctx.font = `${f2}px ${fam}`; c.font = mctx.font;
                    if (draw) c.fillText('KEY:', x0, y);
                    y += f2 * 1.8;
                    const rw2 = mctx.measureText('XVIII.').width + f2 * 0.6;
                    entries.forEach((t, i) => {
                        if (draw) c.fillText(romanize(i + 1) + '.', x0, y);
                        textBlock(t, colW - rw2).forEach(l => { if (draw) c.fillText(l, x0 + rw2, y); y += f2 * 1.45; });
                        y += f2 * 0.3;
                    });
                }
                return y;
            };
            let k = 1;
            for (let t = 0; t < 10 && flow(k, false) > H - M; t++) k *= 0.92;
            c.fillStyle = P.ink; flow(k, true);
        },
    };


    /* =====================================================
     * 模板 9：缺字填空（挖掉的字变成字块，位置可自己拖；背景可换成图片）
     * ===================================================== */
    const CLOZE_PAL = {
        wine: { top: '#6b1a1f', ink: '#ffffff', blank: '#efe9e1', bottom: '#ece8e0', tileBg: '#6b1a1f', tileInk: '#ffffff' },
        cream: { top: '#d9d0bf', ink: '#111111', blank: '#7b2a2e', bottom: '#7b2a2e', tileBg: '#e9e2d0', tileInk: '#111111' },
        dusk: { top: '#050505', ink: '#f1f1f1', blank: '#9b1c10', bottom: '#0a0a0a', tileBg: '#000000', tileInk: '#ffffff' },
    };
    const cloze = {
        id: 'cloze',
        name: '缺字填空',
        hint: '点文字里的字：它变成空格，并出现成字块。按住字块可拖到任意位置，轻点字块可放回原处。',
        defaults: Object.assign({ palette: 'wine', areaOrder: 'below', tileArea: 'color', textArea: 'color', dim: 25, arrange: 'wave', tileScale: 100, tilt: 40, title: false, fontSize: 4.2, font: 'serif', bottomPct: 90, grain: 20 }, CLOZE_PAL.wine),
        controls: [
            { group: '版面', key: 'areaOrder', label: '字块区的位置', type: 'select', options: [['below', '在文字下方'], ['above', '在文字上方']] },
            { group: '版面', key: 'bottomPct', label: '字块区高度 %', type: 'range', min: 40, max: 160, step: 5 },
            { group: '版面', key: 'title', label: '第一行当标题（居中，不参与挖字）', type: 'checkbox', onChange() { S.cloze = { order: [], pos: {} }; } },
            { group: '背景', key: 'tileArea', label: '字块区背景', type: 'select', options: [['color', '纯色'], ['image', '用图片']] },
            { group: '背景', key: 'textArea', label: '文字区背景', type: 'select', options: [['color', '纯色'], ['image', '用图片']] },
            { group: '背景', key: 'dim', label: '文字区图片压暗 %', type: 'range', min: 0, max: 80, step: 1, show: P => P.textArea === 'image' },
            { group: '字块', key: 'arrange', label: '默认排列', type: 'select', options: [['row', '一排'], ['wave', '波浪'], ['scatter', '散落']] },
            { group: '字块', key: 'tileScale', label: '字块大小 %', type: 'range', min: 60, max: 180, step: 5 },
            { group: '字块', key: 'tilt', label: '字块倾斜程度', type: 'range', min: 0, max: 100, step: 5 },
            { group: '字块', key: 'resetPos', label: '字块排回默认位置', type: 'button', onClick() { S.cloze.pos = {}; } },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 2.5, max: 8, step: 0.1 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '颜色', key: 'palette', label: '配色方案', type: 'select', options: [['wine', '酒红'], ['cream', '米色'], ['dusk', '黑夜']], onChange(v) { const pl = CLOZE_PAL[v]; if (pl) Object.entries(pl).forEach(([k, val]) => ui.setParam(k, val)); } },
            { group: '颜色', key: 'top', label: '文字区底色', type: 'color' },
            { group: '颜色', key: 'ink', label: '文字颜色', type: 'color' },
            { group: '颜色', key: 'blank', label: '空格颜色', type: 'color' },
            { group: '颜色', key: 'bottom', label: '字块区底色', type: 'color' },
            { group: '颜色', key: 'tileBg', label: '字块底色', type: 'color' },
            { group: '颜色', key: 'tileInk', label: '字块文字色', type: 'color' },
            { group: '质感', key: 'grain', label: '纸张颗粒 %', type: 'range', min: 0, max: 100, step: 5 },
        ],
        snap() { return JSON.stringify({ o: S.cloze.order, p: S.cloze.pos || {} }); },
        restore(str) { const d = JSON.parse(str); S.cloze = { order: d.o, pos: d.p || {} }; },
        clear() { S.cloze = { order: [], pos: {} }; },
        render(cv, c, P) {
            S.cloze ??= { order: [], pos: {} };
            S.cloze.pos ??= {};
            const W = 1200, M = 90, fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
            mctx.font = `${fs}px ${fam}`;
            const toks = tokenize((S.text || '').trim() || SAMPLE_CLOZE, 'char');
            const titleEnd = P.title ? toks.findIndex(t => t.nl) : -1;
            const spaceW = mctx.measureText(' ').width;
            const mk = (tk, i) => tk.nl ? { nl: true, w: 0 } : { i, t: tk.t, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) };
            const tItems = P.title ? toks.map(mk).filter((it, i) => i < titleEnd) : [];
            const bItems = toks.map(mk).filter((it, i) => !(P.title && i <= titleEnd));
            const tLines = wrap(tItems, W - 2 * M), bLines = wrap(bItems, W - 2 * M);
            const lh = fs * 1.5;
            const textH = Math.round(M * 1.1 + (tLines.length + bLines.length) * lh + M * 0.8);
            const asp = imgH(S.img) / imgW(S.img);
            const tileH = P.tileArea === 'image' ? Math.round(W * asp * P.bottomPct / 100) : Math.round(textH * P.bottomPct / 100);
            const above = P.areaOrder === 'above';
            const tileY = above ? 0 : textH, textY = above ? tileH : 0;
            cv.width = W; cv.height = textH + tileH;
            const bg = (mode, color, x, y, w, h, dim) => {
                if (mode === 'image') { drawCover(c, S.img, x, y, w, h); if (dim > 0) { c.fillStyle = `rgba(0,0,0,${dim / 100})`; c.fillRect(x, y, w, h); } }
                else { c.fillStyle = color; c.fillRect(x, y, w, h); }
            };
            bg(P.textArea, P.top, 0, textY, W, textH, P.dim);
            bg(P.tileArea, P.bottom, 0, tileY, W, tileH, 0);
            c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'left';
            let y = textY + M * 1.1;
            tLines.forEach(l => {
                let x = (W - l.w) / 2;
                l.items.forEach(it => { if (it.nl) return; c.fillStyle = P.ink; c.fillText(it.t, x, y + lh / 2); x += it.w; });
                y += lh;
            });
            bLines.forEach(l => {
                let x = M;
                l.items.forEach(it => {
                    if (it.nl) return;
                    if (S.cloze.order.includes(it.i)) { c.fillStyle = P.blank; c.fillRect(x, y + lh * 0.06, it.w, lh * 0.9); }
                    else { c.fillStyle = P.ink; c.fillText(it.t, x, y + lh / 2); }
                    S.hits.push({ kind: 'chr', i: it.i, x, y, w: it.w, h: lh });
                    x += it.w;
                });
                y += lh;
            });
            const n = S.cloze.order.length, ts = fs * 1.25 * P.tileScale / 100, cyB = tileY + tileH / 2;
            S.clozeGeo = { tileY, tileH, W, ts };
            S.cloze.order.forEach((idx, k) => {
                const ch = toks[idx] ? toks[idx].t : '';
                const along = n > 1 ? k / (n - 1) : 0.5;
                let tx, ty;
                if (P.arrange === 'scatter') { tx = M + ts / 2 + hash(idx * 3 + 7) * (W - 2 * M - ts); ty = tileY + ts / 2 + hash(idx * 3 + 9) * Math.max(1, tileH - ts); }
                else { tx = M + ts / 2 + (W - 2 * M - ts) * along; ty = cyB + (P.arrange === 'wave' ? Math.sin(k * 0.9) * tileH * 0.28 : 0); }
                const ps = S.cloze.pos[idx];
                if (ps) { tx = ps.fx * W; ty = tileY + ps.fy * tileH; }
                tx = clamp(tx, ts / 2, W - ts / 2); ty = clamp(ty, tileY + ts / 2, tileY + tileH - ts / 2);
                c.save(); c.translate(tx, ty); c.rotate((hash(idx + 5) - 0.5) * (P.tilt / 100) * 0.35);
                c.fillStyle = P.tileBg; c.fillRect(-ts / 2, -ts / 2, ts, ts);
                c.fillStyle = P.tileInk; c.font = `${ts * 0.76}px ${fam}`; c.textAlign = 'center'; c.fillText(ch, 0, 0);
                c.restore();
                S.hits.push({ kind: 'tile', idx, x: tx - ts / 2, y: ty - ts / 2, w: ts, h: ts });
            });
            applyGrain(c, W, cv.height, P.grain);
        },
        onDown(x, y) {
            S.cloze ??= { order: [], pos: {} };
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if (h.kind === 'tile' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
                    S.drag = { tile: h.idx, sx: x, sy: y, cx: h.x + h.w / 2, cy: h.y + h.h / 2, moved: false };
                    return true;
                }
            }
            const h = S.hits.find(h => h.kind === 'chr' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
            if (!h) return false;
            const has = S.cloze.order.includes(h.i);
            S.cloze.order = has ? S.cloze.order.filter(v => v !== h.i) : [...S.cloze.order, h.i];
            S.drag = { cloze: true, val: !has };
            return true;
        },
        onMove(x, y) {
            const d = S.drag, g = S.clozeGeo;
            if (!d) return false;
            if (d.tile !== undefined) {
                if (!g) return false;
                if (Math.hypot(x - d.sx, y - d.sy) > 6) d.moved = true;
                if (d.moved) {
                    const nx = clamp(d.cx + (x - d.sx), g.ts / 2, g.W - g.ts / 2), ny = clamp(d.cy + (y - d.sy), g.tileY + g.ts / 2, g.tileY + g.tileH - g.ts / 2);
                    S.cloze.pos[d.tile] = { fx: nx / g.W, fy: (ny - g.tileY) / g.tileH };
                }
                return true;
            }
            if (!d.cloze) return false;
            const h = S.hits.find(h => h.kind === 'chr' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
            if (!h) return false;
            const has = S.cloze.order.includes(h.i);
            if (d.val && !has) { S.cloze.order = [...S.cloze.order, h.i]; return true; }
            if (!d.val && has) { S.cloze.order = S.cloze.order.filter(v => v !== h.i); return true; }
            return false;
        },
        onUp() {
            const d = S.drag;
            if (d && d.tile !== undefined && !d.moved) {
                S.cloze.order = S.cloze.order.filter(v => v !== d.tile);
                delete S.cloze.pos[d.tile];
            }
            S.drag = null;
        },
    };

    /* ---------- 模板注册 ---------- */
    function register(t) {
        TEMPLATES[t.id] = t;
        if (overlay) refreshTplSelect();
    }
    [cutout, blackout, captcha, shape, timeline, detect, board, cloze].forEach(t => TEMPLATES[t.id] = t);
    window.CutoutPoster = {
        register, templates: TEMPLATES,
        util: { S, pathShape, tokenize, wrap, fontFamily, mulberry32, clamp, paintDown, paintMove },
    };

    async function runSavedTemplates() {
        try {
            for (const rec of await dbAll('tpls')) {
                try { new Function('CutoutPoster', rec.code)(window.CutoutPoster); }
                catch (e) { console.warn('[CutoutPoster] template failed', rec.name, e); }
            }
        } catch (e) { /* ignore */ }
    }

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
        } catch (e) { /* 回退直接加载 */ }
        return new Promise((res, rej) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => res(im);
            im.onerror = () => rej(new Error('图片加载失败'));
            im.src = url;
        });
    }
    function setImage(im, isCrop) {
        S.img = im; if (!isCrop) S.srcImg = im;
        S.imgId++;
        S.cut.holes = []; S.sel = -1; S.boxes = []; S.undo = [];
    }

    /* =====================================================
     * 面板
     * ===================================================== */
    let overlay = null, cv = null, c2d = null, rafPending = false;
    const panelPos = { x: 0, y: 0 };
    const fontLoading = new Set();
    const $ = sel => overlay.querySelector(sel);

    function curTpl() { return TEMPLATES[getSettings().template] || TEMPLATES.cutout; }
    function params() {
        const st = getSettings(), tpl = curTpl();
        st.params[tpl.id] = Object.assign({}, tpl.defaults, st.params[tpl.id]);
        if (tpl.migrate) tpl.migrate(st.params[tpl.id]);
        return st.params[tpl.id];
    }
    function scheduleRender() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; render(); });
    }
    function render() {
        if (!overlay) return;
        const tpl = curTpl(), P = params();
        if (!S.img) setImage(makePlaceholder());
        if (P.font) {
            const fam = fontFamily(P.font);
            if (!fontLoading.has(fam)) {
                fontLoading.add(fam);
                document.fonts.load(`20px ${fam}`).then(() => scheduleRender()).catch(() => {});
            }
        }
        S.hits = [];
        try { tpl.render(cv, c2d, P); }
        catch (e) { console.error('[CutoutPoster] render error', e); toast('渲染出错，详见控制台'); }
        const hint = typeof tpl.hint === 'function' ? tpl.hint(P) : tpl.hint;
        $('#cp_hint').textContent = hint || '';
        syncControls();
        updateVisibility();
    }
    // 导出：用离屏画布重新渲染一遍（不带选中框/辅助线）
    function renderExport() {
        const tpl = curTpl(), P = params();
        const off = document.createElement('canvas');
        S.noGuides = true;
        try { tpl.render(off, off.getContext('2d'), P); } finally { S.noGuides = false; }
        render();
        return off;
    }
    const ui = {
        setParam(key, val) {
            params()[key] = val; saveSettings();
            const el = S.ctls[key];
            if (el) { if (el.type === 'checkbox') el.checked = val; else el.value = val; }
        },
    };
    function updateVisibility() {
        const tpl = curTpl(), P = params();
        tpl.controls.forEach(ct => {
            const el = S.ctls[ct.key];
            if (el && el.parentElement) el.parentElement.style.display = (ct.show && !ct.show(P)) ? 'none' : '';
        });
        (S.cards || []).forEach(card => {
            const any = [...card.querySelectorAll('.cp_ctl')].some(e => e.style.display !== 'none');
            card.style.display = any ? '' : 'none';
        });
    }
    function pushUndo(str) { S.undo.push(str); if (S.undo.length > 60) S.undo.shift(); }
    function syncControls() {
        const tpl = curTpl(), P = params();
        tpl.controls.forEach(ct => {
            if (!ct.get) return;
            const el = S.ctls[ct.key];
            if (!el) return;
            const v = ct.get(P);
            if (v === undefined) return;
            el.value = v;
            if (el._out) el._out.textContent = ' ' + v;
        });
    }
    function buildControls() {
        const tpl = curTpl(), P = params(), box = $('#cp_dyn');
        box.innerHTML = ''; S.ctls = {}; S.cards = [];
        let card = null, lastGroup = null;
        tpl.controls.forEach(ct => {
            const g = ct.group || '参数';
            if (g !== lastGroup) {
                card = document.createElement('div'); card.className = 'cp_card';
                const t = document.createElement('div'); t.className = 'cp_ct'; t.textContent = g;
                card.append(t); box.append(card); S.cards.push(card); lastGroup = g;
            }
            if (ct.type === 'button') {
                const w = document.createElement('div'); w.className = 'cp_ctl';
                const b = document.createElement('button'); b.className = 'cp_btn'; b.textContent = ct.label;
                b.addEventListener('click', () => {
                    const t2 = curTpl();
                    if (t2.snap && !ct.noUndo) pushUndo(t2.snap());
                    ct.onClick(params());
                    render();
                });
                S.ctls[ct.key] = b; w.append(b); card.append(w);
                return;
            }
            const wrap = document.createElement('label');
            wrap.className = 'cp_ctl' + (ct.type === 'checkbox' ? ' cp_inline' : '');
            const span = document.createElement('span');
            span.textContent = ct.label;
            let input;
            if (ct.type === 'select') {
                input = document.createElement('select');
                const opts = typeof ct.options === 'function' ? ct.options() : ct.options;
                opts.forEach(([v, l]) => input.add(new Option(l, v)));
                input.value = P[ct.key];
            } else if (ct.type === 'range') {
                input = document.createElement('input');
                input.type = 'range'; input.min = ct.min; input.max = ct.max; input.step = ct.step;
                input.value = ct.get ? (ct.get(P) ?? ct.min) : P[ct.key];
                const out = document.createElement('b'); out.textContent = ' ' + input.value;
                span.append(out); input._out = out;
                input.addEventListener('input', () => { out.textContent = ' ' + input.value; });
            } else if (ct.type === 'checkbox') {
                input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!P[ct.key];
            } else {
                input = document.createElement('input'); input.type = ct.type === 'color' ? 'color' : 'text'; input.value = P[ct.key];
            }
            input.addEventListener('input', () => {
                const v = ct.type === 'range' ? Number(input.value) : ct.type === 'checkbox' ? input.checked : input.value;
                if (ct.set) ct.set(v, params());
                else { params()[ct.key] = v; saveSettings(); }
                if (ct.onChange) ct.onChange(v);
                scheduleRender();
            });
            S.ctls[ct.key] = input;
            wrap.append(span, input);
            card.append(wrap);
        });
        updateVisibility();
    }
    function refreshTplSelect() {
        const sel = $('#cp_tpl');
        sel.innerHTML = '';
        Object.values(TEMPLATES).forEach(t => sel.add(new Option(t.name, t.id)));
        sel.value = getSettings().template;
    }

    // 画布用 object-fit: contain，需把屏幕坐标换算回画布坐标
    function canvasXY(e) {
        const r = cv.getBoundingClientRect();
        const k = Math.min(r.width / cv.width, r.height / cv.height);
        const w = cv.width * k, h = cv.height * k;
        const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
        return [(e.clientX - ox) / k, (e.clientY - oy) / k];
    }

    function pickFile(accept, cb) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = accept;
        inp.addEventListener('change', () => { if (inp.files[0]) cb(inp.files[0]); });
        inp.click();
    }

    function buildPanel() {
        overlay = document.createElement('div');
        overlay.id = 'cp_overlay';
        const ic = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
        overlay.innerHTML = `
        <div id="cp_panel">
          <div class="cp_head">
            <b>文字抽取成图</b>
            <div class="cp_tools">
              <button id="cp_undo" class="cp_ic" title="撤销">${ic('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>')}</button>
              <button id="cp_clear" class="cp_ic" title="清除全部">${ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>')}</button>
              <button id="cp_export" class="cp_ic" title="保存图片">${ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}</button>
              <button id="cp_toggle" class="cp_ic" title="显示/隐藏设置">${ic('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>')}</button>
              <button id="cp_close" class="cp_ic" title="关闭">${ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}</button>
            </div>
          </div>
          <div class="cp_body">
            <div class="cp_preview"><div class="cp_stage"><canvas id="cp_canvas"></canvas></div></div>
            <div class="cp_side">
              <div id="cp_hint"></div>
              <div class="cp_tabs">
                <button data-tab="a" class="on">内容</button>
                <button data-tab="b">样式</button>
                <button data-tab="c">更多</button>
              </div>
              <div class="cp_pane" data-pane="a">
                <div class="cp_card">
                  <div class="cp_ct">模板</div>
                  <select id="cp_tpl"></select>
                </div>
                <div class="cp_card">
                  <div class="cp_ct">文字</div>
                  <textarea id="cp_text" rows="4" placeholder="${SAMPLE}"></textarea>
                </div>
                <div class="cp_card">
                  <div class="cp_ct">图片</div>
                  <div class="cp_row">
                    <button id="cp_upload" class="cp_btn">上传</button>
                    <button id="cp_avatar" class="cp_btn">角色头像</button>
                    <button id="cp_bg" class="cp_btn">聊天背景</button>
                  </div>
                  <div class="cp_row"><input type="text" id="cp_url" placeholder="图片 URL"><button id="cp_urlgo" class="cp_btn">载入</button></div>
                  <div class="cp_row"><button id="cp_cropbtn" class="cp_btn">裁剪 / 调整大小</button></div>
                </div>
              </div>
              <div class="cp_pane" data-pane="b" style="display:none"><div id="cp_dyn"></div></div>
              <div class="cp_pane" data-pane="c" style="display:none">
                <div class="cp_card">
                  <div class="cp_ct">字体</div>
                  <div class="cp_row"><button id="cp_fontimp" class="cp_btn">导入字体文件</button></div>
                  <label class="cp_ctl"><span>自己输入字体名（字体选“自己输入”时生效）</span><input type="text" id="cp_customfont" placeholder="例如：LXGW WenKai"></label>
                </div>
                <div class="cp_card">
                  <div class="cp_ct">预设与模板</div>
                  <div class="cp_row">
                    <button id="cp_presetout" class="cp_btn">导出预设</button>
                    <button id="cp_presetin" class="cp_btn">导入预设</button>
                  </div>
                  <div class="cp_row"><button id="cp_tplimp" class="cp_btn">导入模板脚本(.js)</button></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div id="cp_shape" style="display:none">
          <div class="cp_expbox">
            <canvas id="cp_shape_cv" width="280" height="280"></canvas>
            <div class="cp_note">用手指一笔画出形状的轮廓，画完点「完成」。</div>
            <div class="cp_row">
              <button id="cp_shape_ok" class="cp_btn">完成</button>
              <button id="cp_shape_clear" class="cp_btn">重画</button>
              <button id="cp_shape_cancel" class="cp_btn">取消</button>
            </div>
          </div>
        </div>
        <div id="cp_crop" style="display:none">
          <div class="cp_expbox">
            <canvas id="cp_crop_cv"></canvas>
            <div class="cp_note">拖动图片可移动位置，滑杆放大/缩小。</div>
            <label class="cp_ctl"><span>画面比例</span>
              <select id="cp_crop_ratio">
                <option value="orig">原比例</option><option value="1:1">1:1</option><option value="4:3">4:3</option><option value="3:4">3:4</option>
                <option value="3:2">3:2</option><option value="2:3">2:3</option><option value="16:9">16:9</option><option value="9:16">9:16</option>
              </select></label>
            <label class="cp_ctl"><span>缩放</span><input type="range" id="cp_crop_zoom" min="1" max="5" step="0.05" value="1"></label>
            <label class="cp_ctl"><span>输出最长边（越小越流畅）</span>
              <select id="cp_crop_out"><option value="800">800</option><option value="1200">1200</option><option value="1600" selected>1600</option><option value="2400">2400</option></select></label>
            <div class="cp_row">
              <button id="cp_crop_ok" class="cp_btn">应用</button>
              <button id="cp_crop_reset" class="cp_btn">重置</button>
              <button id="cp_crop_cancel" class="cp_btn">取消</button>
            </div>
          </div>
        </div>
        <div id="cp_exp" style="display:none">
          <div class="cp_expbox">
            <img id="cp_expimg" alt="">
            <div class="cp_row">
              <button id="cp_exp_dl" class="cp_btn">下载</button>
              <button id="cp_exp_share" class="cp_btn">分享/存相册</button>
              <button id="cp_exp_copy" class="cp_btn">复制</button>
              <button id="cp_exp_close" class="cp_btn">关闭</button>
            </div>
            <div class="cp_note">没反应的话，长按上面的图片，选“下载图片 / 保存图片”。</div>
          </div>
        </div>`;
        document.body.append(overlay);
        cv = $('#cp_canvas'); c2d = cv.getContext('2d');

        refreshTplSelect();
        $('#cp_tpl').addEventListener('change', e => {
            getSettings().template = e.target.value; saveSettings();
            S.undo = []; S.drag = null;
            buildControls(); render();
        });
        $('#cp_customfont').value = getSettings().customFont;
        $('#cp_customfont').addEventListener('input', e => { getSettings().customFont = e.target.value.trim(); saveSettings(); scheduleRender(); });

        overlay.addEventListener('mousedown', e => { if (e.target === overlay) closePanel(); });
        $('#cp_close').addEventListener('click', closePanel);
        $('#cp_toggle').addEventListener('click', () => { overlay.classList.toggle('cp_focus'); setTimeout(render, 30); });
        $('#cp_text').addEventListener('input', e => { S.text = e.target.value; S.keep = null; S.slots = new Set(); S.cloze = { order: [], pos: {} }; scheduleRender(); });
        overlay.querySelectorAll('.cp_tabs button').forEach(b => b.addEventListener('click', () => {
            overlay.querySelectorAll('.cp_tabs button').forEach(x => x.classList.toggle('on', x === b));
            overlay.querySelectorAll('.cp_pane').forEach(p => { p.style.display = p.dataset.pane === b.dataset.tab ? '' : 'none'; });
        }));

        // 图片来源
        $('#cp_upload').addEventListener('click', () => pickFile('image/*', async f => {
            try { setImage(await loadImage(URL.createObjectURL(f))); render(); } catch (err) { toast(err.message); }
        }));
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

        // 顶部工具
        $('#cp_undo').addEventListener('click', () => {
            const tpl = curTpl();
            if (!S.undo.length || !tpl.restore) return;
            tpl.restore(S.undo.pop()); render();
        });
        $('#cp_clear').addEventListener('click', () => {
            const tpl = curTpl();
            if (!tpl.clear) return;
            if (tpl.snap) S.undo.push(tpl.snap());
            tpl.clear(); render();
        });
        // 保存：先弹出预览，再下载 / 分享 / 复制（每个按钮都是一次新的点击，不会被浏览器拦截）
        let expBlob = null, expUrl = null;
        const closeExp = () => {
            $('#cp_exp').style.display = 'none';
            if (expUrl) { URL.revokeObjectURL(expUrl); expUrl = null; }
            $('#cp_expimg').removeAttribute('src');
        };
        $('#cp_exp_close').addEventListener('click', closeExp);
        $('#cp_export').addEventListener('click', () => {
            const tpl = curTpl();
            if (tpl.exportOk && !tpl.exportOk(params())) return toast(tpl.exportMsg || '还没有内容可以导出');
            try {
                const off = renderExport();
                off.toBlob(b => {
                    if (!b) return toast('导出失败：图片跨域，请改用上传');
                    if (expUrl) URL.revokeObjectURL(expUrl);
                    expBlob = b; expUrl = URL.createObjectURL(b);
                    $('#cp_expimg').src = expUrl;
                    $('#cp_exp').style.display = 'flex';
                }, 'image/png');
            } catch (e) { toast('导出失败：图片跨域，请改用上传'); }
        });
        $('#cp_exp_dl').addEventListener('click', () => {
            if (!expUrl) return;
            const a = document.createElement('a');
            a.href = expUrl; a.download = `cutout_${Date.now()}.png`;
            document.body.append(a); a.click();
            setTimeout(() => a.remove(), 0);
        });
        $('#cp_exp_share').addEventListener('click', async () => {
            if (!expBlob) return;
            const f = new File([expBlob], `cutout_${Date.now()}.png`, { type: 'image/png' });
            try {
                if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] });
                else toast('此环境不支持分享，请长按图片保存');
            } catch (e) { /* 取消分享 */ }
        });
        $('#cp_exp_copy').addEventListener('click', async () => {
            if (!expBlob) return;
            try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': expBlob })]); toast('已复制'); }
            catch (e) { toast('复制失败，请长按图片保存'); }
        });

        // 图片裁剪 / 调整大小
        let crop = null;
        const cropSrc = () => S.srcImg || S.img;
        const cropRect = () => {
            const src = cropSrc(), W = imgW(src), H = imgH(src);
            let r = W / H;
            if (crop.ratio !== 'orig') { const [a, b] = crop.ratio.split(':').map(Number); r = a / b; }
            const bw = Math.min(W, H * r), bh = bw / r, cw = bw / crop.zoom, ch = bh / crop.zoom;
            return { x: clamp(crop.cx * W - cw / 2, 0, W - cw), y: clamp(crop.cy * H - ch / 2, 0, H - ch), w: cw, h: ch };
        };
        const drawCrop = () => {
            const src = cropSrc(), r = cropRect(), cc = $('#cp_crop_cv');
            const k = Math.min(320 / r.w, 320 / r.h);
            cc.width = Math.max(1, Math.round(r.w * k)); cc.height = Math.max(1, Math.round(r.h * k));
            cc.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, cc.width, cc.height);
        };
        const resetCrop = () => {
            crop = { ratio: 'orig', zoom: 1, cx: 0.5, cy: 0.5, out: 1600 };
            $('#cp_crop_ratio').value = 'orig'; $('#cp_crop_zoom').value = 1; $('#cp_crop_out').value = '1600';
            drawCrop();
        };
        $('#cp_cropbtn').addEventListener('click', () => {
            if (!S.img) setImage(makePlaceholder());
            if (!S.srcImg) S.srcImg = S.img;
            $('#cp_crop').style.display = 'flex';
            resetCrop();
        });
        $('#cp_crop_ratio').addEventListener('input', e => { crop.ratio = e.target.value; drawCrop(); });
        $('#cp_crop_zoom').addEventListener('input', e => { crop.zoom = Number(e.target.value); drawCrop(); });
        $('#cp_crop_out').addEventListener('input', e => { crop.out = Number(e.target.value); });
        $('#cp_crop_reset').addEventListener('click', resetCrop);
        $('#cp_crop_cancel').addEventListener('click', () => { $('#cp_crop').style.display = 'none'; });
        $('#cp_crop_ok').addEventListener('click', () => {
            const src = cropSrc(), r = cropRect();
            const k = Math.min(1, crop.out / Math.max(r.w, r.h));
            const o = document.createElement('canvas');
            o.width = Math.max(1, Math.round(r.w * k)); o.height = Math.max(1, Math.round(r.h * k));
            o.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, o.width, o.height);
            setImage(o, true);
            $('#cp_crop').style.display = 'none';
            render();
        });
        let cd = null;
        const ccv = $('#cp_crop_cv');
        ccv.style.touchAction = 'none';
        ccv.addEventListener('pointerdown', e => { cd = { sx: e.clientX, sy: e.clientY, cx: crop.cx, cy: crop.cy }; try { ccv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } });
        ccv.addEventListener('pointermove', e => {
            if (!cd) return;
            const src = cropSrc(), r = cropRect(), rc = ccv.getBoundingClientRect();
            crop.cx = clamp(cd.cx - (e.clientX - cd.sx) * (r.w / rc.width) / imgW(src), 0, 1);
            crop.cy = clamp(cd.cy - (e.clientY - cd.sy) * (r.h / rc.height) / imgH(src), 0, 1);
            drawCrop();
        });
        const cEnd = () => { cd = null; };
        ccv.addEventListener('pointerup', cEnd); ccv.addEventListener('pointercancel', cEnd);

        // 字体 / 预设 / 模板导入
        $('#cp_fontimp').addEventListener('click', () => pickFile('.ttf,.otf,.woff,.woff2', async f => {
            try {
                const name = f.name.replace(/\.[^.]+$/, '');
                const buf = await f.arrayBuffer();
                const ff = new FontFace(name, buf.slice(0));
                await ff.load(); document.fonts.add(ff);
                if (!importedFonts.includes(name)) importedFonts.push(name);
                try { await dbPut('fonts', { name, buf }); } catch (e) { toast('字体已加载，但无法永久保存'); }
                buildControls();
                if ('font' in params()) ui.setParam('font', 'imp:' + name);
                render(); toast('已导入字体：' + name);
            } catch (e) { toast('字体导入失败'); }
        }));
        $('#cp_presetout').addEventListener('click', () => {
            const st = getSettings();
            download(new Blob([JSON.stringify({ cutoutPoster: 1, template: st.template, params: st.params, customFont: st.customFont }, null, 2)], { type: 'application/json' }), 'cutout_preset.json');
        });
        $('#cp_presetin').addEventListener('click', () => pickFile('.json', async f => {
            try {
                const d = JSON.parse(await f.text());
                if (!d.cutoutPoster) throw new Error('bad');
                const st = getSettings();
                if (TEMPLATES[d.template]) st.template = d.template;
                Object.assign(st.params, d.params || {});
                if (d.customFont) { st.customFont = d.customFont; $('#cp_customfont').value = d.customFont; }
                saveSettings(); refreshTplSelect(); buildControls(); render(); toast('预设已导入');
            } catch (e) { toast('预设文件无效'); }
        }));
        $('#cp_tplimp').addEventListener('click', () => pickFile('.js', async f => {
            try {
                const code = await f.text();
                if (!confirm('模板脚本会在本页面执行，只导入你信任的文件。继续吗？')) return;
                new Function('CutoutPoster', code)(window.CutoutPoster);
                try { await dbPut('tpls', { name: f.name, code }); } catch (e) { /* ignore */ }
                refreshTplSelect(); toast('模板已导入');
            } catch (e) { console.error(e); toast('模板脚本出错，详见控制台'); }
        }));

        // 画布交互
        cv.addEventListener('pointerdown', e => {
            const tpl = curTpl();
            if (!tpl.onDown) return;
            const [x, y] = canvasXY(e);
            const before = tpl.snap ? tpl.snap() : null;
            if (tpl.onDown(x, y, params(), ui)) {
                if (before !== null) pushUndo(before);
                try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                e.preventDefault();
                render();
            }
        });
        cv.addEventListener('pointermove', e => {
            const tpl = curTpl();
            if (!tpl.onMove || !S.drag) return;
            const [x, y] = canvasXY(e);
            if (tpl.onMove(x, y, params(), ui)) scheduleRender();
        });
        const up = () => { const tpl = curTpl(); if (tpl.onUp) tpl.onUp(); else S.drag = null; render(); };
        cv.addEventListener('pointerup', up);
        cv.addEventListener('pointercancel', up);

        // 按住标题栏可以拖动整个面板（标题栏不会被拖出屏幕；双击标题栏回到居中）
        const head = $('.cp_head');
        let pd = null, lastTap = 0, lastX = 0, lastY = 0;
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const now = Date.now();
            if (now - lastTap < 320 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 14) {
                panelPos.x = 0; panelPos.y = 0; $('#cp_panel').style.transform = ''; lastTap = 0; return;
            }
            lastTap = now; lastX = e.clientX; lastY = e.clientY;
            const r = $('#cp_panel').getBoundingClientRect();
            pd = { sx: e.clientX, sy: e.clientY, ox: panelPos.x, oy: panelPos.y, bl: r.left - panelPos.x, bt: r.top - panelPos.y, bw: r.width };
            try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });
        head.addEventListener('pointermove', e => {
            if (!pd) return;
            const W = window.innerWidth, H = window.innerHeight;
            panelPos.x = clamp(pd.ox + e.clientX - pd.sx, 60 - (pd.bl + pd.bw), W - 60 - pd.bl);
            panelPos.y = clamp(pd.oy + e.clientY - pd.sy, -pd.bt, H - 48 - pd.bt);
            $('#cp_panel').style.transform = `translate(${panelPos.x}px,${panelPos.y}px)`;
        });
        const endDrag = () => { pd = null; };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);

        // 手绘自定义形状 / 用图片做形状
        let padPts = [], padDown = false;
        const padCv = $('#cp_shape_cv');
        padCv.style.touchAction = 'none';
        const drawPad = () => {
            const pc = padCv.getContext('2d');
            pc.clearRect(0, 0, 280, 280);
            pc.fillStyle = 'rgba(255,255,255,.08)'; pc.fillRect(0, 0, 280, 280);
            if (padPts.length > 1) {
                pc.beginPath(); padPts.forEach((q, i) => i ? pc.lineTo(q[0], q[1]) : pc.moveTo(q[0], q[1])); pc.closePath();
                pc.fillStyle = 'rgba(59,155,255,.35)'; pc.fill(); pc.strokeStyle = '#3b9bff'; pc.lineWidth = 3; pc.stroke();
            }
        };
        const padXY = e => { const r = padCv.getBoundingClientRect(); return [(e.clientX - r.left) * 280 / r.width, (e.clientY - r.top) * 280 / r.height]; };
        padCv.addEventListener('pointerdown', e => { padDown = true; padPts = [padXY(e)]; try { padCv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } drawPad(); });
        padCv.addEventListener('pointermove', e => {
            if (!padDown) return;
            const q = padXY(e), l = padPts[padPts.length - 1];
            if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 3) { padPts.push(q); drawPad(); }
        });
        const padEnd = () => { padDown = false; };
        padCv.addEventListener('pointerup', padEnd); padCv.addEventListener('pointercancel', padEnd);
        const addCustomShape = r => {
            const st = getSettings();
            st.customShapes.push(r); saveSettings();
            buildControls();
            const key = 'custom:' + (st.customShapes.length - 1), P = params();
            if (curTpl().id === 'shape') ui.setParam('tshape', key); else if ('shape' in P) ui.setParam('shape', key);
            render();
        };
        ui.openShapePad = () => { padPts = []; drawPad(); $('#cp_shape').style.display = 'flex'; };
        ui.pickShapeImage = () => pickFile('image/*', async f => {
            try {
                const im = await loadImage(URL.createObjectURL(f));
                const r = shapeFromImage(im);
                if (!r) return toast('没能从图片里识别出形状（建议用透明底，或白底深色图案）');
                addCustomShape(r); toast('已添加自定义形状');
            } catch (e) { toast('图片加载失败'); }
        });
        ui.deleteCustomShape = key => {
            const st = getSettings();
            st.customShapes[+String(key).slice(7)] = null; saveSettings();
            const P = params();
            if (P.shape === key) P.shape = 'square';
            if (P.tshape === key) P.tshape = 'circle';
            buildControls(); render();
        };
        $('#cp_shape_clear').addEventListener('click', () => { padPts = []; drawPad(); });
        $('#cp_shape_cancel').addEventListener('click', () => { $('#cp_shape').style.display = 'none'; });
        $('#cp_shape_ok').addEventListener('click', () => {
            if (padPts.length < 8) return toast('先用手指画一个形状');
            const r = normalizeShape(padPts);
            if (!r) return toast('形状太小，再画大一点');
            $('#cp_shape').style.display = 'none';
            addCustomShape(r);
        });

        buildControls();
    }

    function closePanel() { overlay.classList.remove('open'); document.body.style.overflow = ''; ['#cp_exp', '#cp_crop', '#cp_shape'].forEach(q => { const e = overlay.querySelector(q); if (e) e.style.display = 'none'; }); }

    function openPanel(text) {
        if (!overlay) buildPanel();
        if (typeof text === 'string' && text.trim()) {
            S.text = text.trim();
            $('#cp_text').value = S.text;
            S.keep = null; S.slots = new Set(); S.cloze = { order: [], pos: {} };
        }
        panelPos.x = 0; panelPos.y = 0;
        $('#cp_panel').style.transform = '';
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
        btn.textContent = '抽取成图';
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
            const bw = btn.offsetWidth || 100, bh = btn.offsetHeight || 32;
            // 放在选区下方（避开手机系统自带的上方菜单和选择把手）
            let top = r.bottom + 34;
            if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 60);
            btn.style.top = top + 'px';
            btn.style.left = clamp(r.left + r.width / 2 - bw / 2, 8, window.innerWidth - bw - 8) + 'px';
        };
        let timer = null;
        document.addEventListener('mouseup', () => setTimeout(check, 10));
        document.addEventListener('touchend', () => setTimeout(check, 200));
        document.addEventListener('selectionchange', () => { clearTimeout(timer); timer = setTimeout(check, 300); });
        btn.addEventListener('pointerdown', e => e.preventDefault());
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', () => {
            const t = lastText;
            hide();
            // 清掉选区，避免手机上残留选中高亮和系统菜单
            try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
            try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { /* ignore */ }
            openPanel(t);
        });
    }


    function initImageButton() {
        const btn = document.createElement('div');
        btn.id = 'cp_img_btn';
        btn.textContent = '用这张图制作';
        document.body.append(btn);
        let src = '';
        const hide = () => { btn.style.display = 'none'; };
        document.addEventListener('click', e => {
            const t = e.target;
            if (t && t.closest && t.closest('#cp_img_btn')) return;
            const im = t && t.closest ? t.closest('#chat .mes_text img, #chat img.mes_img') : null;
            if (!im || (t.closest && t.closest('#cp_overlay'))) { hide(); return; }
            src = im.currentSrc || im.src;
            if (!src) { hide(); return; }
            const r = im.getBoundingClientRect();
            btn.style.display = 'block';
            const bw = btn.offsetWidth || 110, bh = btn.offsetHeight || 32;
            let top = r.bottom + 10;
            if (top + bh > window.innerHeight - 8) top = Math.max(8, r.bottom - bh - 10);
            btn.style.top = top + 'px';
            btn.style.left = clamp(r.left + r.width / 2 - bw / 2, 8, window.innerWidth - bw - 8) + 'px';
        }, true);
        document.addEventListener('scroll', hide, true);
        btn.addEventListener('pointerdown', e => e.preventDefault());
        btn.addEventListener('click', async () => {
            hide();
            try { const im = await loadImage(src); openPanel(''); setImage(im); render(); }
            catch (e) { toast('图片加载失败（可能是跨域），请保存后用「上传」'); }
        });
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

    async function init() {
        initSelection(); initImageButton(); addMenuEntry();
        await loadSavedFonts();
        await runSavedTemplates();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
