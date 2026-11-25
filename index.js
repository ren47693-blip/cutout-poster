/* 入口：按顺序加载 core / templates / panel */
(async () => {
    'use strict';
    const base = new URL('.', import.meta.url).href;
    const load = src => new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = res;
        s.onerror = () => rej(new Error('加载失败: ' + src));
        document.head.append(s);
    });
    try {
        for (const f of ['core.js', 'templates.js', 'panel.js']) await load(base + f);
    } catch (e) {
        console.error('[CutoutPoster]', e);
    }
})();
