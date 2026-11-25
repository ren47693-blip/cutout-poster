/* 文字抽取成图 (Cutout Poster) v1.1 —— panel.js
 * 面板 UI、交互、入口。依赖 core.js 与 templates.js。
 */
(() => {
    'use strict';
    const CP = window.__CP;
    if (!CP) { console.error('[CutoutPoster] core.js 没有先加载'); return; }
    const {
        SAMPLE, clamp, toast, download, getSettings, saveSettings, dbAll, dbPut,
        importedFonts, fontFamily, S, TEMPLATES, imgW, imgH,
        normalizeShape, shapeFromImage, makePlaceholder, loadImage, setImage,
        cropToCanvas, ui,
    } = CP;

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
    // 导出：离屏重画一遍，不带选中框和辅助提示
    function renderExport() {
        const tpl = curTpl(), P = params();
        const off = document.createElement('canvas');
        S.noGuides = true;
        try { tpl.render(off, off.getContext('2d'), P); } finally { S.noGuides = false; }
        render();
        return off;
    }

    /* ---------- 分页与分组 ---------- */
    const TABS = [['src', '素材'], ['layout', '版面'], ['elem', '元素'], ['text', '文字'], ['look', '外观'], ['more', '更多']];
    const GROUP_TAB = {
        '版面': 'layout', '背景': 'layout', '排字方式': 'layout', '排布': 'layout', '点选': 'layout',
        '网格': 'layout', '波浪': 'layout', '关系图': 'layout', '画面': 'layout', '玩法': 'layout',
        '形状': 'elem', '大小与角度': 'elem', '大小': 'elem', '选中的字': 'elem', '字块': 'elem',
        '选区': 'elem', '唱片': 'elem', '胶壳': 'elem', '阴影': 'elem', '标注线': 'elem',
        '文字': 'text', '文字排版': 'text', '附加文字': 'text',
        '颜色': 'look', '质感': 'look',
    };
    function activateTab(key) {
        overlay.querySelectorAll('.cp_tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === key));
        overlay.querySelectorAll('.cp_pane').forEach(pn => { pn.style.display = pn.dataset.pane === key ? '' : 'none'; });
    }
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
        TABS.forEach(([k]) => {
            if (k === 'src' || k === 'more') return;
            const pane = overlay.querySelector(`.cp_pane[data-pane="${k}"]`);
            const btn = overlay.querySelector(`.cp_tabs button[data-tab="${k}"]`);
            if (!pane || !btn) return;
            const any = [...pane.querySelectorAll('.cp_card')].some(cd => cd.style.display !== 'none');
            btn.style.display = any ? '' : 'none';
        });
        const cur = overlay.querySelector('.cp_tabs button.on');
        if (cur && cur.style.display === 'none') activateTab('src');
    }

    /* ---------- 撤销栈 ---------- */
    let lastPU = null;
    function pushUndo(entry) {
        if (typeof entry === 'string') lastPU = null;
        S.undo.push(entry);
        if (S.undo.length > 60) S.undo.shift();
    }
    function recordParamUndo(tplId, key, old) {
        const now = Date.now();
        if (lastPU && lastPU.key === key && lastPU.tpl === tplId && now - lastPU.t < 1500) { lastPU.t = now; return; }
        lastPU = { key, tpl: tplId, t: now };
        S.undo.push({ p: true, tpl: tplId, key, val: old });
        if (S.undo.length > 60) S.undo.shift();
    }
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

    /* ---------- 防误触滑杆：只有按住圆点左右拖才改值 ---------- */
    function makeSlider(min, max, step, value) {
        const el = document.createElement('div');
        el.className = 'cp_sl';
        const mkBtn = t => { const b = document.createElement('button'); b.type = 'button'; b.className = 'cp_sl_step'; b.textContent = t; return b; };
        const dec = mkBtn('−'), inc = mkBtn('+');
        const track = document.createElement('div'); track.className = 'cp_sl_track';
        const rail = document.createElement('div'); rail.className = 'cp_sl_rail';
        const fill = document.createElement('div'); fill.className = 'cp_sl_fill';
        const thumb = document.createElement('div'); thumb.className = 'cp_sl_thumb';
        track.append(rail, fill, thumb);
        el.append(dec, track, inc);
        const snapV = v => { v = clamp(Number(v), min, max); const k = Math.round((v - min) / step); return +(min + k * step).toFixed(4); };
        let cur = snapV(value);
        const paint = () => { const pc = max > min ? (cur - min) / (max - min) * 100 : 0; fill.style.width = pc + '%'; thumb.style.left = pc + '%'; };
        const fire = () => el.dispatchEvent(new Event('input'));
        const setVal = (v, emit) => { v = snapV(v); if (v === cur) return; cur = v; paint(); if (emit) fire(); };
        Object.defineProperty(el, 'value', { get: () => String(cur), set: v => { cur = snapV(v); paint(); } });
        paint();
        dec.addEventListener('click', () => setVal(cur - step, true));
        inc.addEventListener('click', () => setVal(cur + step, true));
        let d = null;
        thumb.addEventListener('pointerdown', e => {
            const r = track.getBoundingClientRect();
            d = { sx: e.clientX, sy: e.clientY, v0: cur, w: Math.max(1, r.width), on: false };
            try { thumb.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });
        thumb.addEventListener('pointermove', e => {
            if (!d) return;
            const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
            if (!d.on) { if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) d.on = true; else return; }
            setVal(d.v0 + dx / d.w * (max - min), true);
        });
        thumb.addEventListener('pointerup', () => { d = null; });
        thumb.addEventListener('pointercancel', () => { if (d && d.v0 !== cur) setVal(d.v0, true); d = null; });
        return el;
    }

    /* ---------- 控件：每个模板的 DOM 建好就缓存，切换时只换显隐 ---------- */
    const tplDom = {};
    function buildControlsFor(tplId) {
        const tpl = TEMPLATES[tplId], P = params();
        const cards = [], ctls = {};
        const cardMap = new Map();
        tpl.controls.forEach(ct => {
            const g = ct.group || '参数', tab = GROUP_TAB[g] || 'layout', ck = tab + '|' + g;
            let card = cardMap.get(ck);
            if (!card) {
                card = document.createElement('div');
                card.className = 'cp_card closed';           // 默认折叠
                card.dataset.tpl = tplId;
                const head = document.createElement('div'); head.className = 'cp_ct cp_ct_dyn'; head.textContent = g;
                const body = document.createElement('div'); body.className = 'cp_cb';
                const key2 = tplId + '|' + g;
                if (S.opened.has(key2)) card.classList.remove('closed');   // 之前手动展开过的保持展开
                head.addEventListener('click', () => {
                    card.classList.toggle('closed');
                    if (card.classList.contains('closed')) S.opened.delete(key2);
                    else S.opened.add(key2);
                });
                card.append(head, body); card._body = body;
                overlay.querySelector(`.cp_pane[data-pane="${tab}"]`).append(card);
                cardMap.set(ck, card); cards.push(card);
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
                ctls[ct.key] = b; w.append(b); card._body.append(w);
                return;
            }
            const wrap = document.createElement(ct.type === 'range' ? 'div' : 'label');
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
                input = makeSlider(ct.min, ct.max, ct.step, ct.get ? (ct.get(P) ?? ct.min) : P[ct.key]);
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
                const old = ct.get ? ct.get(params()) : params()[ct.key];
                if (old !== undefined) recordParamUndo(tplId, ct.key, old);
                if (ct.set) ct.set(v, params());
                else { params()[ct.key] = v; saveSettings(); }
                if (ct.onChange) ct.onChange(v);
                scheduleRender();
            });
            ctls[ct.key] = input;
            wrap.append(span, input);
            card._body.append(wrap);
        });
        tplDom[tplId] = { cards, ctls };
        return tplDom[tplId];
    }
    function useControls(tplId) {
        const dom = tplDom[tplId] || buildControlsFor(tplId);
        Object.entries(tplDom).forEach(([id, d]) => {
            const on = id === tplId;
            d.cards.forEach(cd => { cd.style.display = on ? '' : 'none'; });
        });
        S.ctls = dom.ctls; S.cards = dom.cards;
        const P = params(), tpl = TEMPLATES[tplId];
        tpl.controls.forEach(ct => {
            const el = dom.ctls[ct.key];
            if (!el || ct.type === 'button') return;
            const v = ct.get ? ct.get(P) : P[ct.key];
            if (v === undefined) return;
            if (ct.type === 'checkbox') el.checked = !!v;
            else el.value = v;
            if (el._out) el._out.textContent = ' ' + v;
        });
        updateVisibility();
    }
    function refreshDynOptions() {
        Object.entries(tplDom).forEach(([id, d]) => {
            const tpl = TEMPLATES[id];
            if (!tpl) return;
            tpl.controls.forEach(ct => {
                if (ct.type !== 'select' || typeof ct.options !== 'function') return;
                const el = d.ctls[ct.key];
                if (!el) return;
                const keep = el.value;
                el.innerHTML = '';
                ct.options().forEach(([v, l]) => el.add(new Option(l, v)));
                el.value = keep;
            });
        });
    }
    function refreshTplSelect() {
        const sel = $('#cp_tpl');
        sel.innerHTML = '';
        Object.values(TEMPLATES).forEach(t => sel.add(new Option(t.name, t.id)));
        sel.value = getSettings().template;
    }
    ui.refreshTplSelect = () => { if (overlay) refreshTplSelect(); };

    /* ---------- 坐标换算（画布 object-fit: contain） ---------- */
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
    function pickFiles(accept, cb) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = accept; inp.multiple = true;
        inp.addEventListener('change', () => { if (inp.files.length) cb([...inp.files]); });
        inp.click();
    }

    /* ---------- 面板构建 ---------- */
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
            <div class="cp_grip" id="cp_grip" title="拖动调整预览/设置的大小；双击恢复"><span></span></div>
            <div class="cp_side">
              <div id="cp_hint"></div>
              <div class="cp_tabs">
                <button data-tab="src" class="on">素材</button>
                <button data-tab="layout">版面</button>
                <button data-tab="elem">元素</button>
                <button data-tab="text">文字</button>
                <button data-tab="look">外观</button>
                <button data-tab="more">更多</button>
              </div>
              <div class="cp_panes">
                <div class="cp_pane" data-pane="src">
                  <div class="cp_card">
                    <div class="cp_ct">模板</div>
                    <select id="cp_tpl"></select>
                  </div>
                  <div class="cp_card">
                    <div class="cp_ct">文字内容</div>
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
                <div class="cp_pane" data-pane="layout" style="display:none"></div>
                <div class="cp_pane" data-pane="elem" style="display:none"></div>
                <div class="cp_pane" data-pane="text" style="display:none"></div>
                <div class="cp_pane" data-pane="look" style="display:none"></div>
                <div class="cp_pane" data-pane="more" style="display:none">
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
        <div id="cp_pick" style="display:none">
          <div class="cp_expbox">
            <canvas id="cp_pick_cv"></canvas>
            <div class="cp_note" id="cp_pick_note">在图上拖一个方框，然后点「加进素材」。可以反复框、反复加。</div>
            <div class="cp_row">
              <button id="cp_pick_src" class="cp_btn">换一张图来截</button>
              <button id="cp_pick_add" class="cp_btn">加进素材</button>
            </div>
            <div class="cp_row">
              <button id="cp_pick_clr" class="cp_btn">清空素材</button>
              <button id="cp_pick_close" class="cp_btn">完成</button>
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
            useControls(e.target.value);
            render();
        });
        $('#cp_customfont').value = getSettings().customFont;
        $('#cp_customfont').addEventListener('input', e => {
            getSettings().customFont = e.target.value.trim(); saveSettings(); scheduleRender();
        });

        overlay.addEventListener('mousedown', e => { if (e.target === overlay) closePanel(); });
        $('#cp_close').addEventListener('click', closePanel);
        $('#cp_toggle').addEventListener('click', () => { overlay.classList.toggle('cp_focus'); setTimeout(render, 30); });
        $('#cp_text').addEventListener('input', e => {
            S.text = e.target.value;
            S.keep = null; S.slots = new Set();
            S.cloze = CP.newCloze ? CP.newCloze() : null;
            S.wsGrid = null; S.wsMark = new Set();
            S.boardPts = {}; S.boardCur = 0;
            scheduleRender();
        });
        overlay.querySelectorAll('.cp_tabs button').forEach(b => b.addEventListener('click', () => activateTab(b.dataset.tab)));

        /* 预览 / 设置 之间的拖动条 */
        const grip = $('#cp_grip'), bodyEl = $('.cp_body'), sideEl = $('.cp_side');
        const isCol = () => { try { return getComputedStyle(bodyEl).flexDirection === 'column'; } catch (e) { return false; } };
        let gd = false, gTap = 0;
        grip.addEventListener('pointerdown', e => {
            const nowT = Date.now();
            if (nowT - gTap < 320) { sideEl.style.flex = ''; const st = getSettings(); delete st.sideSize; saveSettings(); gTap = 0; return; }
            gTap = nowT; gd = true;
            try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });
        grip.addEventListener('pointermove', e => {
            if (!gd) return;
            const br = bodyEl.getBoundingClientRect(), col = isCol();
            let px = col ? br.bottom - e.clientY : br.right - e.clientX;
            px = clamp(px, 90, Math.max(120, (col ? br.height : br.width) - 110));
            sideEl.style.flex = `0 0 ${Math.round(px)}px`;
            const st = getSettings(); (st.sideSize ??= {})[col ? 'col' : 'row'] = Math.round(px);
        });
        const gEnd = () => { if (gd) { gd = false; saveSettings(); } };
        grip.addEventListener('pointerup', gEnd); grip.addEventListener('pointercancel', gEnd);
        overlay._applySide = () => {
            const ss = getSettings().sideSize, v = ss && ss[isCol() ? 'col' : 'row'];
            sideEl.style.flex = v ? `0 0 ${v}px` : '';
        };

        /* 图片来源 */
        $('#cp_upload').addEventListener('click', () => pickFile('image/*', async f => {
            try { setImage(await loadImage(URL.createObjectURL(f))); render(); } catch (err) { toast(err.message); }
        }));
        $('#cp_avatar').addEventListener('click', async () => {
            const x = CP.getCtx();
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

        /* 顶部工具 */
        $('#cp_undo').addEventListener('click', () => {
            const tpl = curTpl();
            const e = S.undo.pop();
            if (e === undefined) return;
            lastPU = null;
            if (typeof e === 'string') { if (tpl.restore) tpl.restore(e); }
            else if (e.p && e.tpl === tpl.id) {
                const ct = tpl.controls.find(x => x.key === e.key);
                if (ct && ct.set) ct.set(e.val, params()); else ui.setParam(e.key, e.val);
                if (ct && ct.onChange) ct.onChange(e.val);
            }
            render();
        });
        $('#cp_clear').addEventListener('click', () => {
            const tpl = curTpl();
            if (!tpl.clear) return;
            if (tpl.snap) pushUndo(tpl.snap());
            tpl.clear(); render();
        });

        /* 保存：先弹预览，再下载 / 分享 / 复制 */
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

        /* 裁剪 / 调整大小 */
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
        ccv.addEventListener('pointerdown', e => {
            cd = { sx: e.clientX, sy: e.clientY, cx: crop.cx, cy: crop.cy };
            try { ccv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });
        ccv.addEventListener('pointermove', e => {
            if (!cd) return;
            const src = cropSrc(), r = cropRect(), rc = ccv.getBoundingClientRect();
            crop.cx = clamp(cd.cx - (e.clientX - cd.sx) * (r.w / rc.width) / imgW(src), 0, 1);
            crop.cy = clamp(cd.cy - (e.clientY - cd.sy) * (r.h / rc.height) / imgH(src), 0, 1);
            drawCrop();
        });
        const cEnd = () => { cd = null; };
        ccv.addEventListener('pointerup', cEnd); ccv.addEventListener('pointercancel', cEnd);

        /* 从一张图里框选若干块当素材（九宫格用） */
        let pickImg = null, pickBox = null, pickDrag = null, pickTarget = 'captcha';
        const pcv = $('#cp_pick_cv');
        pcv.style.touchAction = 'none';
        const drawPick = () => {
            if (!pickImg) return;
            const maxW = 340;
            const k = Math.min(maxW / imgW(pickImg), 300 / imgH(pickImg));
            pcv.width = Math.max(1, Math.round(imgW(pickImg) * k));
            pcv.height = Math.max(1, Math.round(imgH(pickImg) * k));
            const pc = pcv.getContext('2d');
            pc.drawImage(pickImg, 0, 0, pcv.width, pcv.height);
            if (pickBox) {
                const x = Math.min(pickBox.x0, pickBox.x1) * pcv.width;
                const y = Math.min(pickBox.y0, pickBox.y1) * pcv.height;
                const w = Math.abs(pickBox.x1 - pickBox.x0) * pcv.width;
                const h = Math.abs(pickBox.y1 - pickBox.y0) * pcv.height;
                pc.save();
                pc.fillStyle = 'rgba(0,0,0,.35)';
                pc.fillRect(0, 0, pcv.width, pcv.height);
                pc.clearRect(x, y, w, h);
                pc.drawImage(pickImg, Math.min(pickBox.x0, pickBox.x1) * imgW(pickImg), Math.min(pickBox.y0, pickBox.y1) * imgH(pickImg),
                    Math.abs(pickBox.x1 - pickBox.x0) * imgW(pickImg), Math.abs(pickBox.y1 - pickBox.y0) * imgH(pickImg), x, y, w, h);
                pc.setLineDash([7, 5]); pc.lineWidth = 2; pc.strokeStyle = '#3b9bff';
                pc.strokeRect(x, y, w, h);
                pc.restore();
            }
        };
        const pickXY = e => {
            const r = pcv.getBoundingClientRect();
            return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
        };
        pcv.addEventListener('pointerdown', e => {
            const [x, y] = pickXY(e);
            pickDrag = { x0: x, y0: y };
            pickBox = { x0: x, y0: y, x1: x, y1: y };
            try { pcv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            drawPick();
        });
        pcv.addEventListener('pointermove', e => {
            if (!pickDrag) return;
            const [x, y] = pickXY(e);
            pickBox = { x0: pickDrag.x0, y0: pickDrag.y0, x1: x, y1: y };
            drawPick();
        });
        const pickEnd = () => { pickDrag = null; };
        pcv.addEventListener('pointerup', pickEnd);
        pcv.addEventListener('pointercancel', pickEnd);
        const pickCount = () => {
            const n = (S.capImgs || []).length;
            $('#cp_pick_note').textContent = n
                ? `在图上拖一个方框，然后点「加进素材」。已有 ${n} 块素材。`
                : '在图上拖一个方框，然后点「加进素材」。可以反复框、反复加。';
        };
        $('#cp_pick_src').addEventListener('click', () => pickFile('image/*', async f => {
            try { pickImg = await loadImage(URL.createObjectURL(f)); pickBox = null; drawPick(); }
            catch (e) { toast('图片加载失败'); }
        }));
        $('#cp_pick_add').addEventListener('click', () => {
            if (!pickImg) return toast('先选一张图');
            if (!pickBox || Math.abs(pickBox.x1 - pickBox.x0) < 0.02 || Math.abs(pickBox.y1 - pickBox.y0) < 0.02) {
                return toast('先在图上拖一个方框');
            }
            const piece = cropToCanvas(pickImg, pickBox.x0, pickBox.y0, pickBox.x1, pickBox.y1, 900);
            if (pickTarget === 'captcha') { S.capImgs ??= []; S.capImgs.push(piece); }
            pickCount();
            toast('已加入素材');
            render();
        });
        $('#cp_pick_clr').addEventListener('click', () => {
            if (pickTarget === 'captcha') S.capImgs = [];
            pickCount(); render(); toast('素材已清空');
        });
        $('#cp_pick_close').addEventListener('click', () => { $('#cp_pick').style.display = 'none'; });

        /* 字体 / 预设 / 模板导入 */
        $('#cp_fontimp').addEventListener('click', () => pickFile('.ttf,.otf,.woff,.woff2', async f => {
            try {
                const name = f.name.replace(/\.[^.]+$/, '');
                const buf = await f.arrayBuffer();
                const ff = new FontFace(name, buf.slice(0));
                await ff.load(); document.fonts.add(ff);
                if (!importedFonts.includes(name)) importedFonts.push(name);
                try { await dbPut('fonts', { name, buf }); } catch (e) { toast('字体已加载，但无法永久保存'); }
                refreshDynOptions();
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
                saveSettings(); refreshTplSelect();
                useControls(st.template); render(); toast('预设已导入');
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

        /* 画布交互 */
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
        const up = () => {
            const tpl = curTpl();
            if (tpl.onUp) tpl.onUp(params(), ui); else S.drag = null;
            render();
        };
        cv.addEventListener('pointerup', up);
        cv.addEventListener('pointercancel', up);

        /* 拖动整个面板；双击标题栏回到居中 */
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

        /* 手绘形状 */
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
        const padXY = e => {
            const r = padCv.getBoundingClientRect();
            return [(e.clientX - r.left) * 280 / r.width, (e.clientY - r.top) * 280 / r.height];
        };
        padCv.addEventListener('pointerdown', e => {
            padDown = true; padPts = [padXY(e)];
            try { padCv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            drawPad();
        });
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
            refreshDynOptions();
            const key = 'custom:' + (st.customShapes.length - 1), P = params();
            if (curTpl().id === 'shape') ui.setParam('tshape', key);
            else if ('shape' in P) ui.setParam('shape', key);
            render();
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

        /* 模板里会调用的 ui.* 方法 */
        ui.setParam = (key, val) => {
            params()[key] = val; saveSettings();
            const el = S.ctls[key];
            if (el) {
                if (el.type === 'checkbox') el.checked = val; else el.value = val;
                if (el._out) el._out.textContent = ' ' + val;
            }
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
            refreshDynOptions();
            useControls(curTpl().id);
            render();
        };
        ui.addBoardImage = () => pickFile('image/*', async f => {
            try {
                S.boardImgs.push(await loadImage(URL.createObjectURL(f)));
                render(); toast('已追加，共 ' + (S.boardImgs.length + 1) + ' 张');
            } catch (e) { toast('图片加载失败'); }
        });
        ui.pickVinylImage = slot => pickFile('image/*', async f => {
            try {
                S.vinylImgs[slot] = await loadImage(URL.createObjectURL(f));
                render(); toast(slot === 'sleeve' ? '已换封套底图' : '已换中心标签图');
            } catch (e) { toast('图片加载失败'); }
        });
        ui.pickWsImage = () => pickFile('image/*', async f => {
            try {
                S.wsImg = await loadImage(URL.createObjectURL(f));
                render(); toast('已换藏在底下的图');
            } catch (e) { toast('图片加载失败'); }
        });
        ui.addCaptchaImages = () => pickFiles('image/*', async files => {
            S.capImgs ??= [];
            let ok = 0;
            for (const f of files) {
                try { S.capImgs.push(await loadImage(URL.createObjectURL(f))); ok++; }
                catch (e) { /* 跳过失败的 */ }
            }
            render();
            toast(ok ? '共 ' + S.capImgs.length + ' 块素材' : '图片加载失败');
        });
        // 打开「从图里截一块」窗口，默认用当前主图
        ui.openCropPicker = target => {
            pickTarget = target || 'captcha';
            pickImg = S.srcImg || S.img;
            pickBox = null;
            $('#cp_pick').style.display = 'flex';
            pickCount();
            drawPick();
        };

        useControls(getSettings().template);
    }

    function closePanel() {
        overlay.classList.remove('open');
        document.body.style.overflow = '';
        ['#cp_exp', '#cp_crop', '#cp_shape', '#cp_pick'].forEach(q => { const e = overlay.querySelector(q); if (e) e.style.display = 'none'; });
    }

    function openPanel(text) {
        if (!overlay) buildPanel();
        if (typeof text === 'string' && text.trim()) {
            S.text = text.trim();
            $('#cp_text').value = S.text;
            S.keep = null; S.slots = new Set();
            S.cloze = CP.newCloze ? CP.newCloze() : null;
            S.wsGrid = null; S.wsMark = new Set();
            S.boardPts = {}; S.boardCur = 0;
        }
        panelPos.x = 0; panelPos.y = 0;
        $('#cp_panel').style.transform = '';
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        if (overlay._applySide) overlay._applySide();
        render();
    }

    /* ---------- 划词按钮 ---------- */
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
            try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
            try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { /* ignore */ }
            openPanel(t);
        });
    }

    /* ---------- 图片按钮 ---------- */
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

    /* ---------- 扩展菜单入口 ---------- */
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

    async function runSavedTemplates() {
        try {
            for (const rec of await dbAll('tpls')) {
                try { new Function('CutoutPoster', rec.code)(window.CutoutPoster); }
                catch (e) { console.warn('[CutoutPoster] template failed', rec.name, e); }
            }
        } catch (e) { /* ignore */ }
    }

    async function init() {
        initSelection(); initImageButton(); addMenuEntry();
        await CP.loadSavedFonts();
        await runSavedTemplates();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
