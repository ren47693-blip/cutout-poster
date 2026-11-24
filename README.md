# 文字抽取成图 (Cutout Poster) v0.4 —— SillyTavern 扩展

## 安装
Git URL：扩展面板 → Install extension → 粘贴 https://github.com/你的用户名/cutout-poster
或把整个文件夹放进 SillyTavern/public/scripts/extensions/third-party/ 后刷新页面。

## 使用
选中聊天里的文字 → 选区下方出现「抽取成图」→ 点开面板。
- 按住标题栏可以拖动整个面板。
- 顶部图标依次：撤销、清除、保存图片、显示/隐藏设置、关闭。
- 设置分三页：内容 / 样式 / 更多。
- 保存图片：弹出预览，可「下载」「分享/存相册」「复制」；下载没反应时，长按预览图保存。
- 图片：上传 / 角色头像 / 聊天背景 / URL；「裁剪 / 调整大小」可拖动、缩放、换比例。

## 模板（全部手动操作）
1. 挖洞置换：点图挖洞；洞可拖动、单独调大小、碎片角度；形状含拼图/水滴/四角星/小鸟等；
   碎片可放在图旁（对应位置/聚拢/网格/排成一个字）、图外边框里、或文字槽位里。
2. 涂黑诗：点词留字，黑块只出现在留字的范围内。
3. 验证码九宫格。
4. 色块替换：涂抹方块，左右对照，色块上可写字。
5. 文字塑形：文字沿着画面暗/亮区域排布。
6. 切边时间表：每行文字一个色块，图上拖动调切入深度。
7. 检测框关系图：图上拖框，下方生成关系图。
8. 图版标注：标题 + 说明 + 罗马数字图例。
9. 剪影文字：手指描轮廓，里面填色和文字。
10. 缺字填空：点字挖空，挖掉的字出现在下方。

## 字体 / 预设 / 模板脚本
「更多」页：导入字体文件（ttf/otf/woff/woff2）、手动输入字体名、导出/导入预设(.json)、导入模板脚本(.js，只导入你信任的文件)。
默认字体跟随酒馆主题。

模板脚本格式：
    CutoutPoster.register({
      id: 'mine', name: '我的模板', hint: '提示',
      defaults: { color: '#ff0000' },
      controls: [{ group: '颜色', key: 'color', label: '颜色', type: 'color' }],
      render(cv, ctx, P) { /* 设 cv.width/height 后画图；文字在 CutoutPoster.util.S.text */ }
    });
可选钩子：onDown(x,y,P,ui) / onMove / onUp / snap / restore / clear / exportOk。
