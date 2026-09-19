# 结构检查的证据与边界

`web_inspect(mode="detect")` 是排版辅助检查，不是像素级视觉验收。报告保持既有 `summary`、`issues`、`structure` 格式，并在 metadata 内补充证据。

| 字段 | 含义 |
|---|---|
| `confidence` | high / medium / low，证据本身的可信程度，不是设计错误的概率 |
| `assessment` | confirmed 为已验证的覆盖或测量事实；candidate 需视觉复核 |
| `evidenceKind` | 文字行框、绘制顺序、实色覆盖采样等证据来源 |
| `reasonCodes` | 可用于筛选和回归的判断原因 |
| `inspectionLimitations` | 位于结构页 metadata，说明没有检查或无法证明的范围 |

高置信度覆盖仍可能是有意的弹层设计；不能把 `confirmed` 直接解释为必须修改。只有几何交叠的候选不再仅因相交面积大就升级成 error。正常背景、卡片、容器里的空白和可滚动内容不应直接被判为遮挡。

## 网页

文字使用直接文本节点的行框，避免父容器重复继承整棵子树文字。浏览器绘制顺序采样可证明当前视口中不透明层覆盖了哪些内容位置；行框仍非精确字形像素。`pointer-events:none` 层、视口外内容、图片透明区、圆角、变换、伪元素、iframe 和 shadow DOM 等不能以普通命中测试完全证明，报告保留相应限制或几何候选。

扫描最多 2000 个元素，每元素最多 80 个文字行框，覆盖采样最多 1200 个点；交叠分析最多检查 30000 对元素和 100000 对内容矩形，规则报告最多返回 200 条。达到边界会在 `inspectionLimitations` 中标明，并按需返回 `detectionTruncated=true`，不把未检查区域算成通过。

一次 DOM 检查最多生成 10 张问题截图，优先已采样确证的覆盖。其余问题保留在报告中，metadata 标记 `screenshotStatus="budget_exceeded"`；inline/file 两种交付都明确返回附图不完整提示，不将漏图当作完整成功。

溢出判断针对内容和非滚动裁剪区域，不把正常滚动范围当作裁剪缺陷。DOM 的 alignment 参数保持兼容，但不跨无关布局组自动推断错位，需要截图复核。

## PPTX 与 PDF

PPTX 保留绘制顺序、填充透明度和原生组变换，背景在文字之前绘制不代表遮挡。文字行位置仍为字体近似估算：自动换行、内边距、字体缩放参与判断，但母版继承、复杂路径、图片透明度、表格/图表和动画可见性没有完整解析。文字框相交但估计行不相交仍可能保留低置信候选；不能用估算证明实际渲染正常。

PDF 增加向量绘制顺序与原生字形边框证据，后绘不透明矩形完整盖住文字与正常底色分别处理。字形边框不是字形轮廓，透明组合与复杂剪裁只能给出候选或限制。

两个文档检查器每请求最多 200 条问题、20000 对元素比较；PDF 自动附图最多 8 张，单图预估超过 4MP 或任一边超过 4096 像素时不渲染并说明原因。结构中的 `inspectionBudget.notExhaustive` 和 `inspectionLimitations` 表明预算截断；这些预算不等于给整个原生文件解析器设置了内存硬上限。

PPTX detect 本身提供结构问题，不自动产生局域附图。需要画面时直接调用 `web_fetch_screenshot(file://...pptx, page=...)` 或使用 `ai_review`，无需用户自行转换 PDF。

## 运行与复核

`npm run build` 同步 TypeScript 编译与 Python 检查器资源复制，两个 Python 入口和同目录 helper 必须一起部署。Python 环境需要已有 `python-pptx` 和 `PyMuPDF`，可通过 `WEB_FETCHER_PYTHON` 指定解释器；只更换 Node 不能补齐 Python 库。

先看报告的限制，再结合 `reasonCodes` 和截图确认。对同一页面的桌面、窄屏、横屏分别传 `viewport:{width,height}` 检查；不传时保留默认尺寸。PPT/PDF 的页尺寸不由网页 viewport 改写。

测试使用背景与遮挡、留白与文字交叠、滚动与隐藏裁剪的成对样例。真实文档的告警减少只能说明行为变化；必须同时保留有问题的阳性样例，才可判断没有为了减少误报而压掉所有告警。
