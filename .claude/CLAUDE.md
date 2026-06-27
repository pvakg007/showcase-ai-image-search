# AI图库 项目规则

## 绝对规则：按 AI 上限分组调用，绝不逐张

**批量上传的图片按 AI 单次接收上限（5 张）分组，每组一次性提交一次 AI 调用；绝不为每张图单独调用 AI。** 即调用次数 = `ceil(图片数 / 5)`，是满足 AI 物理限制的**最少**调用次数。

### 规则内容

- 用户批量上传 N 张图：按 5 张一组分批，顺序调用 AI（7 张=5+2 两批，12 张=5+5+2 三批，以此类推）
- 每批内部，所有图片打包在**同一次 AI 调用**中发送，用提示词连接规则区分每张图
- 仅"重新分析（单图）"或"分张上传"才允许真正的单张调用
- 禁止通过自链（self-chain）或循环方式**逐张**调用 AI（分批 ≠ 逐张：分批是 5 张一组，逐张是 1 张一次）

### 原因

- AI 单次最多接收 5 张图片（物理上限），>5 张必须分批
- 逐张调用 = N 倍费用 + N 倍等待；分批是 `ceil(N/5)` 次，远少于 N
- AI 原生支持多图输入，每批返回的结构化 JSON 足以区分该批每张图

### 实现方式

分批在 `src/lib/pipeline.js` 的 `runPipeline` 中完成（`BATCH_SIZE = 5`），每批：

1. 按全局顺序取 5 张图，**批内**标注"图1...图K"（本地图索引）
2. 一次 AI 调用，返回该批的 `spaceSoftDecorationAnalysis[]`
3. 每条记录通过 `spaceName` 中的"（图K）"关联到该批对应图片
4. `materials` 位于 `spaceSoftDecorationAnalysis` 内部（per-space），随空间过滤
5. `extractSearchFields(analysis, localIndex, spaceNames)` / `buildMarkdown(..., localIndex)` 用**批内本地索引**过滤
6. 每批完成立即写 checkpoint（`job.batches[].done` + `progressLog`），中途出错或关页面可从未完成批续跑
