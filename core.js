/* 文字抽取成图 (Cutout Poster) v1.1 —— core.js
 * 公共工具 / 运行时状态 / 形状路径 / 图片加载
 * 本文件创建全局命名空间 window.__CP，供 templates.js 和 panel.js 使用。
 * 加载顺序必须是 core → templates → panel。
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

    /* ---------- 文字分词 ---------- */
    const CJK = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
    const TOKEN_RE = new RegExp(`{\\s*}|[${CJK}]|[^\\s${CJK}{]+|{`, 'g');
    let segmenter = null;
    function tokenizeLine(line, gran) {
        const out = [];
        if (gran === 'word' && window.Intl && Intl.Segmenter) {
            segmenter ??= new Intl.Segmenter(['zh', 'en'], { granularity: 'word' });
            for (const part of line.split(/({\s*})/)) {
                if (!part) continue;
                if (/^{\s*}$/.test(part)) { out.push({ t: part, slot: true, sp: false }); continue; }
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
            out.push({ t, slot: /^{\s*}$/.test(t), sp: !!nxt && /\s/.test(nxt) });
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
    // 需要先设置 mctx.font；返回按宽度折行后的每行字符串
    function textBlock(text, maxW) {
        const spaceW = mctx.measureText(' ').width;
        const items = tokenize(text, 'char').map(tk => tk.nl ? { nl: true, w: 0 }
            : { t: tk.t, sp: tk.sp, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
        return wrap(items, maxW).map(l => l.items.filter(i => !i.nl).map(i => i.t + (i.sp ? ' ' : '')).join(''));
    }

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

    /* ---------- 形状路径 ---------- */
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
    const BASE_SHAPES = [['square', '方形'], ['circle', '圆形'], ['rect', '长方形'], ['ellipse', '椭圆'],
        ['diamond', '菱形'], ['triangle', '三角'], ['star', '星形'], ['heart', '爱心'],
        ['puzzle', '拼图'], ['drop', '水滴'], ['sparkle', '四角星光']];
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

    /* ---------- 运行时状态 ---------- */
    const S = {
        text: '', img: null, imgId: 0, hits: [], geo: null,
        cvW: 1200, cvH: 1200,
        cut: { holes: [] }, sel: -1, slots: new Set(), keep: null, cells: null,
        edges: {}, tl: null, boxes: [], tmpBox: null, det: null, noGuides: false,
        detPos: {}, detLab: {}, detLinks: [], detPick: -1,
        boardImgs: [], boardPts: {}, boardCur: 0, boardGeo: null,
        capImgs: [],
        vinylImgs: {},
        wsGrid: null, wsSeed: 1, wsMark: new Set(), wsGeo: null, wsImg: null,
        cloze: null, clozeGeo: null, srcImg: null,
        opened: new Set(),            // 被展开过的分组（默认全部折叠）
        drag: null, undo: [], ctls: {}, cards: [],
    };
    const TEMPLATES = {};
    const imgW = im => im.naturalWidth || im.width;
    const imgH = im => im.naturalHeight || im.height;

    /* ---------- 绘图小工具 ---------- */
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
    function roundRect(c, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
    }
    // 洞的内阴影：裁进洞内，再用一圈带投影的描边，让阴影落在内侧
    function holeInnerShadow(c, shape, cx, cy, w, h, P) {
        const amt = clamp((P.holeShadow || 0) / 100, 0, 1);
        if (amt <= 0) return;
        const ang = (P.shadowAngle ?? 135) * Math.PI / 180;
        const off = Math.min(w, h) * 0.12 * amt;
        const blur = Math.max(2, Math.min(w, h) * 0.22 * amt);
        c.save();
        pathShape(c, shape, cx, cy, w, h);
        c.clip();
        c.shadowColor = `rgba(0,0,0,${0.55 * amt})`;
        c.shadowBlur = blur;
        c.shadowOffsetX = Math.cos(ang) * off;
        c.shadowOffsetY = Math.sin(ang) * off;
        c.strokeStyle = 'rgba(0,0,0,1)';
        c.lineWidth = Math.max(3, blur);
        pathShape(c, shape, cx, cy, w + c.lineWidth, h + c.lineWidth);
        c.stroke();
        c.restore();
    }
    // 碎片的外投影：画碎片前调用，调用方负责 save/restore
    function setDropShadow(c, size, P) {
        const amt = clamp((P.fragShadow || 0) / 100, 0, 1);
        if (amt <= 0) return false;
        const ang = (P.shadowAngle ?? 135) * Math.PI / 180;
        c.shadowColor = `rgba(0,0,0,${0.5 * amt})`;
        c.shadowBlur = size * 0.1 * amt + 2;
        c.shadowOffsetX = Math.cos(ang) * size * 0.05 * amt;
        c.shadowOffsetY = Math.sin(ang) * size * 0.05 * amt;
        return true;
    }

    /* ---------- 挖洞碎片相关（多个模板共用） ---------- */
    function holeGeom(P, h, IW, IH) {
        const w = (h.size ?? P.size) / 100;
        const hp = (IW * w * shapeRatio(P)) / IH;
        return {
            cx: clamp(h.cx, Math.min(w / 2, 0.5), Math.max(1 - w / 2, 0.5)),
            cy: clamp(h.cy, Math.min(hp / 2, 0.5), Math.max(1 - hp / 2, 0.5)),
            w, h: hp,
        };
    }
    // rot = 碎片自己的角度；hrot = 洞的角度（碎片里的图案按洞的方向取，再转回来）
    function drawFrag(c, P, g, dcx, dcy, dw, dh, rot, hrot, srcImg) {
        const img = srcImg || S.img, iwp = imgW(img), ihp = imgH(img);
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

    /* ---------- 从一张图里截一块，返回新的 canvas ---------- */
    function cropToCanvas(img, fx0, fy0, fx1, fy1, maxSide) {
        const W = imgW(img), H = imgH(img);
        const x = Math.max(0, Math.min(fx0, fx1) * W), y = Math.max(0, Math.min(fy0, fy1) * H);
        const w = Math.max(1, Math.abs(fx1 - fx0) * W), h = Math.max(1, Math.abs(fy1 - fy0) * H);
        const k = Math.min(1, (maxSide || 1200) / Math.max(w, h));
        const o = document.createElement('canvas');
        o.width = Math.max(1, Math.round(w * k));
        o.height = Math.max(1, Math.round(h * k));
        o.getContext('2d').drawImage(img, x, y, w, h, 0, 0, o.width, o.height);
        return o;
    }

    /* ---------- 示例文字 ---------- */
    const SAMPLES = {
        cloze: '夫天地者，万物之逆旅也；\n光阴者，百代之过客也。\n而浮生若梦，为欢几何？',
        timeline: '5/12  CONCEPT PHOTO #1\n5/15  CONCEPT PHOTO #2\n5/16  CONCEPT PHOTO #3\n\n5/22  TRACKLIST\n\n5/29  ALBUM RELEASE',
        detect: 'maybe we are all main characters\njust crossing paths in each others stories',
        board: 'DESIGN AND RESEARCH\nThis design proposal developed out of the practice of making large-scale drawings, models and environments.\nTime-based plan of the proposed process\nSketch development\nModel, restoration hangar\nPortfolio, precedents\nBuilding components booklet\nRelief section',
        vinyl: 'MIDNIGHT SIDE\nside A\nFirst Light\nParade of Small Hours\nSalt and Static\nThe Long Way Round\nside B\nPaper Boats\nUndertow\nLast Train Home',
        ws: 'LONGING\nSILENCE\nEMBER\nTIDE\nLANTERN\nVELVET',
    };

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

    /* ---------- 图片加载 ---------- */
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
        S.cut.holes = []; S.sel = -1; S.boxes = [];
        S.detPos = {}; S.detLab = {}; S.detLinks = []; S.detPick = -1;
        S.boardImgs = []; S.boardPts = {}; S.boardCur = 0;
        S.undo = [];
    }

    /* ---------- 导出命名空间 ---------- */
    window.__CP = {
        EXT, SAMPLE, SAMPLES,
        getCtx, clamp, mulberry32, toast, download, hash, roundRect,
        holeInnerShadow, setDropShadow, cropToCanvas,
        getSettings, saveSettings, dbAll, dbPut,
        tokenize, tokenizeLine, wrap, mctx, textBlock, textLines, unitsOf, romanize,
        importedFonts, FONT_OPTS, fontFamily, loadSavedFonts,
        pathShape, BASE_SHAPES, SHAPE_OPTS, shapeRatio,
        S, TEMPLATES, imgW, imgH,
        drawCover, applyGrain, RATIOS, RATIO_OPTS,
        holeGeom, drawFrag, drawRing, fillHole,
        paintDown, paintMove,
        simplifyPts, normalizeShape, largestComponent, traceContour, shapeFromImage,
        makePlaceholder, loadImage, setImage,
        ui: {},   // 由 panel.js 填充
    };
    window.__cpGeo = { traceContour, largestComponent, normalizeShape, simplifyPts };
})();
