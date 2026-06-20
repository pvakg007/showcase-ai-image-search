# AI图库 项目规则

## 绝对规则：禁止分张提交 AI 调用

**点击批量上传按钮的图片必须一次性在一个 AI 调用中提交，不得拆分为单张调用来处理。**

### 规则内容

- 用户一次上传多张图片（批量上传）点击”批量上传“按钮，必须将所有图片打包在 **同一次 AI 调用** 中发送
- 用户通过点击"重新分析"（单图）或点击”分张上传“时，才允许单张提交
- 禁止通过自链（self-chain）或循环方式逐张调用 AI

### 原因

- 批量上传拆成单张调用 = N 倍 AI 费用 + N 倍等待时间
- AI 大模型原生支持多图输入，批量返回的结构化 JSON 足以区分每张图片的分析内容

### 实现方式

通过提示词中的连接规则实现每张图片数据过滤，而非通过 AI 调用隔离：

1. 提示词中标注每张图片为"图X：空间名称"格式
2. AI 返回的 `spaceSoftDecorationAnalysis[]` 每条记录通过 `spaceName` 中的"（图X）"关联到对应图片
3. `materials` 数组位于 `spaceSoftDecorationAnalysis` 内部（per-space），天然随空间过滤
4. 代码中通过 `extractSearchFields(analysis, imageIndex)` 和 `buildMarkdown(analysis, url, ts, spaceNames, imageIndex)` 按"（图X）"过滤
