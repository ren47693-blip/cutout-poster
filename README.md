# 文字抽取成图 (Cutout Poster) v0.2 —— SillyTavern 扩展

## 安装
Git URL：扩展面板 → Install extension → 粘贴 https://github.com/你的用户名/cutout-poster
或把整个文件夹放进 SillyTavern/public/scripts/extensions/third-party/ 后刷新页面。

## 使用
选中聊天里的文字 → 选区下方出现「✂ 抽取成图」→ 点开面板。
顶部图标：↩撤销 🗑清除 ⬇导出PNG 📋复制 ⚙显示/隐藏设置 ✕关闭。
全部手动：点图挖洞(再点取消)、点词留字(可划过连选)、点格子选中。

## 字体
- 默认「酒馆主题字体」，跟随你在酒馆美化里设置的字体。
- 「设置 → 字体 / 预设 / 导入模板」里可导入 ttf/otf/woff/woff2 字体，保存在浏览器里，下次自动加载。
- 也可手动输入已安装或酒馆 CSS 里 @font-face 声明过的字体名。

## 预设与模板
- 导出/导入预设(.json)：保存所有模板的参数。
- 导入模板脚本(.js)：只导入你信任的文件。脚本格式：

    CutoutPoster.register({
      id: 'mine', name: '我的模板', hint: '提示文字',
      defaults: { color: '#ff0000' },
      controls: [{ key: 'color', label: '颜色', type: 'color' }],
      render(cv, ctx, P) { /* 设 cv.width/height 后用 ctx 画图，文字在 CutoutPoster.util.S.text */ }
    });

可选钩子：onDown(x,y,P) / onMove / onUp / snap / restore / clear。
