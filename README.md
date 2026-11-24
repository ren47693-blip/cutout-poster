# 文字抽取成图 (Cutout Poster) —— SillyTavern 扩展

## 安装
1. 把整个 `cutout-poster` 文件夹放到：
   `SillyTavern/public/scripts/extensions/third-party/cutout-poster/`
   （多用户版：`data/<用户名>/extensions/cutout-poster/`）
2. 重启或刷新酒馆页面。

## 使用
- 在聊天消息里选中文字 → 旁边出现「✂ 抽取成图」→ 点击打开面板。
- 或：魔法棒菜单（扩展菜单）→「文字抽取成图」，手动输入文字。
- 面板里选模板、选图片（上传 / 角色头像 / 聊天背景 / URL）、调参数，预览实时更新。
- 导出 PNG 或复制图片。

## 现有模板
- 挖洞置换：方/圆/长方/椭圆/菱形/三角/星/心；碎片落在下方，或填进文字的 { } 槽位
- 涂黑诗：整段涂黑，只留选中的词
- 验证码九宫格：图片切格，选中格子打勾

## 新增模板
在别的脚本或 index.js 中调用：
CutoutPoster.register({ id, name, hint, defaults, controls, render(cv, ctx, P), onDown?, onMove?, onUp?, reset?, clear? })
