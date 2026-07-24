## WSF 渲染注意事项

- WSF 不渲染 LaTeX，禁 `$...$`。块级公式用 HTML(KaTeX) → `web_convert` 转 PDF → 给用户可点击的绝对路径
- PDF 交付：在回复正文直接写出 PDF 完整绝对路径（Windows 反斜杠原样写），Cascade 自动渲染成可点击链接。禁 read_file 读 PDF／禁给 web-fetcher 临时路径（会失效）
- 公式转完 PDF 先 `web_fetch_screenshot` 截图确认画出来了再给用户（KaTeX 异步渲染可能空框）
- Markdown 表格里禁裸方括号 `[`（渲染器当链接起始，表格从该行截断），区间等必须用反引号包裹
- 图片单张展示禁拼图（拼一张会糊），每张单独展示确保清晰
