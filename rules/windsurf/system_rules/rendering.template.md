## 渲染注意事项（Windsurf Cascade / Devin Desktop）

- 旧 Windsurf Cascade 面板不渲染 LaTeX、表格裸方括号会截断：禁 `$...$`，块级公式走 HTML(KaTeX) → `web_convert` 转 PDF；区间等方括号用反引号包裹
- Devin Desktop（Devin Local 内核）实测能渲染 LaTeX（行内、块级均正常），表格裸方括号不再截断——上一条对 Devin 作废，公式直接写；金额等非公式的 `$` 注意转义
- 文件交付（PDF 等）：旧 Cascade 在正文直接写完整绝对路径即可点击；Devin Desktop 用宿主规定的文件引用标签给出可点击引用，正文里的 Windows 路径必须用反引号包裹（裸路径的 `\.` `\_` 会被 Markdown 当转义吃掉反斜杠，且不可点）。禁用文件读取工具直接读 PDF 二进制／禁给 web-fetcher 临时路径（会失效）
- 仍需交付独立公式文档时：HTML(KaTeX) → `web_convert` 转 PDF，转完先 `web_fetch_screenshot` 截图确认画出来了（KaTeX 异步渲染可能空框）
- 图片单张展示禁拼图（拼一张会糊），每张单独展示确保清晰
