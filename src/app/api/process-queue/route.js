export const dynamic = "force-dynamic";

import COS from "cos-nodejs-sdk-v5";
import axios from "axios";
import path from "path";
import fs from "fs";

// 动态导入 sharp（ESM 包在 CJS 中的兼容方式）
var sharp = null;
try {
  sharp = require("sharp");
} catch (_) {
  console.warn("sharp 未安装，服务端压缩不可用");
}

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

// ============================================================
// 工具函数
// ============================================================

/** 内嵌默认提示词 */
var EMBEDDED_PROMPT = [
  "---",
  "**指令**：你是资深软装设计专家，请严格按照下方指定的JSON结构，对所有上传图片进行深度软装分析。",
  "**要求**：",
  "1.  我上传的图片会按\"图X：空间名称\"标注（如：图1：客厅、图2：卧室）。",
  "    spaceSoftDecorationAnalysis 中的每一条记录必须通过 spaceName 中的\"（图X）\"明确归属到对应图片，不同图片的分析内容不得混杂。",
  "2.  不得新增、删除、修改任何顶级字段，所有内容必须填充到对应字段内",
  "3.  输出纯JSON代码，不包含任何额外说明文字、注释或Markdown格式",
  "4.  分析内容专业精准，覆盖风格定位、情感格调、硬装衔接、色彩轻重、材质呼应、单品搭配逻辑及通用思路",
  "5.  coreApplication 只返回色彩体系关键词（如'黑白灰+深木色'），不写完整句子",
  "6.  materials 数组位于 spaceSoftDecorationAnalysis 内部，只列出属于当前空间/图片的材质名称，不包含 usage 字段",
  "",
  JSON.stringify(
    {
      styleDefinition: { coreStyle: "", designTechniques: "", emotionalTone: "" },
      overallEmotionalStyle: { coreTemperament: "", detailedInterpretation: [] },
      colorDesignSummary: { coreApplication: "", coreLogic: "", coreTechniques: [], balanceLogic: [] },
      spaceSoftDecorationAnalysis: [],
      generalMatchingIdeas: [],
    },
    null,
    2
  ),
].join("\n");

function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  var m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch (_) {} }
  var b = text.match(/\{[\s\S]*\}/);
  if (b) { try { return JSON.parse(b[0]); } catch (_) {} }
  return null;
}

function extractSearchFields(analysis, imageIndex) {
  // imageIndex: 1-based. 如果提供，只提取匹配 (图N) 的空间数据
  var title = "未命名图片", summary = "暂无总结", tags = [];
  try {
    var sd = analysis?.styleDefinition;
    var oes = analysis?.overallEmotionalStyle;
    var cds = analysis?.colorDesignSummary;
    if (sd?.coreStyle) title = sd.coreStyle;
    var parts = [];
    if (oes?.coreTemperament) parts.push("核心气质：" + oes.coreTemperament);
    if (Array.isArray(oes?.detailedInterpretation)) parts.push.apply(parts, oes.detailedInterpretation);
    if (parts.length > 0) summary = parts.join("；");
    var tagSet = new Set();
    if (sd?.coreStyle) sd.coreStyle.split(/[、,，/\/\s]+/).forEach(function (t) { var c = t.trim(); if (c) tagSet.add(c); });
    if (sd?.designTechniques) sd.designTechniques.split(/[、,，/\/\s]+/).forEach(function (t) { var c = t.trim(); if (c) tagSet.add(c); });
    if (sd?.emotionalTone) sd.emotionalTone.split(/[、,，/\/\s]+/).forEach(function (t) { var c = t.trim(); if (c) tagSet.add(c); });
    // 从 coreApplication 提取色彩体系关键词（如 "黑白灰+深木色" → "黑白灰""深木色"）
    if (cds?.coreApplication) {
      cds.coreApplication.split(/[+、,，/\/\s]+/).forEach(function (t) {
        var c = t.trim();
        if (c) tagSet.add(c);
      });
    }
    // 遍历空间列表，按 (图N) 过滤
    if (Array.isArray(analysis?.spaceSoftDecorationAnalysis)) {
      analysis.spaceSoftDecorationAnalysis.forEach(function (s) {
        // 如果指定了图片编号，只取属于该图片的空间
        if (imageIndex) {
          var suffix = "（图" + imageIndex + "）";
          var suffixAlt = "(图" + imageIndex + ")";
          if (!s?.spaceName || (s.spaceName.indexOf(suffix) === -1 && s.spaceName.indexOf(suffixAlt) === -1)) return;
        }
        if (s?.spaceName) tagSet.add(s.spaceName);
        // 软装单品
        if (Array.isArray(s?.softDecorationItems)) s.softDecorationItems.forEach(function (i) { if (i?.itemName) tagSet.add(i.itemName); });
        // 材质名称（per-space materials）
        if (Array.isArray(s?.materials)) s.materials.forEach(function (m) { if (m) tagSet.add(m); });
      });
    }
    tags = Array.from(tagSet).slice(0, 15);
  } catch (_) {}
  return { title: title, summary: summary, tags: tags };
}

function buildMarkdown(analysis, imageUrl, timestamp, spaceNames, imageIndex) {
  // imageIndex: 1-based. 如果提供，通过 (图N) 过滤空间
  var lines = [];
  try {
    var sd = analysis?.styleDefinition, oes = analysis?.overallEmotionalStyle;
    var cds = analysis?.colorDesignSummary, spaces = analysis?.spaceSoftDecorationAnalysis;
    var ideas = analysis?.generalMatchingIdeas;
    var spaceLabel = Array.isArray(spaceNames) && spaceNames.length > 0 ? spaceNames.join("、") : "";
    lines.push("# " + (sd?.coreStyle || spaceLabel || "设计分析"));
    lines.push("", "---", "");
    if (sd || spaceLabel) {
      lines.push("## 基本信息");
      lines.push("- **上传时间**: " + new Date(timestamp).toLocaleString());
      lines.push("- **图片链接**: [查看原图](" + imageUrl + ")");
      if (spaceLabel) lines.push("- **空间名称**: " + spaceLabel);
      lines.push("");
    }
    if (sd) {
      lines.push("## 风格定义");
      if (sd.coreStyle) lines.push("- **核心风格**: " + sd.coreStyle);
      if (sd.designTechniques) lines.push("- **设计手法**: " + sd.designTechniques);
      if (sd.emotionalTone) lines.push("- **情感基调**: " + sd.emotionalTone);
      lines.push("");
    }
    if (oes) {
      lines.push("## 整体情感格调");
      if (oes.coreTemperament) lines.push("- **核心气质**: " + oes.coreTemperament);
      if (Array.isArray(oes.detailedInterpretation)) {
        lines.push("", "### 详细解读");
        oes.detailedInterpretation.forEach(function (item, i) { lines.push((i + 1) + ". " + item); });
      }
      lines.push("");
    }
    if (cds) {
      lines.push("## 色彩设计总结");
      if (cds.coreApplication) lines.push("- **核心应用**: " + cds.coreApplication);
      if (cds.coreLogic) lines.push("- **核心逻辑**: " + cds.coreLogic);
      if (Array.isArray(cds.coreTechniques)) { lines.push("", "### 核心手法"); cds.coreTechniques.forEach(function (item, i) { lines.push((i + 1) + ". " + item); }); }
      if (Array.isArray(cds.balanceLogic)) { lines.push("", "### 平衡逻辑"); cds.balanceLogic.forEach(function (item, i) { lines.push((i + 1) + ". " + item); }); }
      lines.push("");
    }
    if (Array.isArray(spaces) && spaces.length > 0) {
      // 按 (图N) 过滤：只展示属于当前图片的空间
      var filteredSpaces = spaces;
      if (imageIndex) {
        var figSuffix = "（图" + imageIndex + "）";
        var figSuffixAlt = "(图" + imageIndex + ")";
        filteredSpaces = spaces.filter(function (sp) {
          if (!sp.spaceName) return false;
          return sp.spaceName.indexOf(figSuffix) !== -1 || sp.spaceName.indexOf(figSuffixAlt) !== -1;
        });
      } else if (Array.isArray(spaceNames) && spaceNames.length > 0) {
        filteredSpaces = spaces.filter(function (sp) {
          if (!sp.spaceName) return false;
          return spaceNames.some(function (sn) {
            return sp.spaceName.indexOf(sn) !== -1 || sn.indexOf(sp.spaceName) !== -1;
          });
        });
      }
      if (filteredSpaces.length > 0) {
        lines.push("## 空间软装分析", "");
        filteredSpaces.forEach(function (space, si) {
          lines.push("### " + (si + 1) + ". " + (space.spaceName || "未命名空间"));
          if (space.functionalAdaptation) lines.push("- **功能适配**: " + space.functionalAdaptation);
          if (space.hardwareBase) lines.push("- **硬装基础**: " + space.hardwareBase);
          if (Array.isArray(space.materials)) {
            lines.push("", "**运用材质：**");
            space.materials.forEach(function (mat) { lines.push("- " + mat); });
          }
          if (Array.isArray(space.softDecorationItems)) {
            lines.push("", "**软装单品：**");
            space.softDecorationItems.forEach(function (item) { lines.push("- **" + item.itemName + "**: " + item.matchingLogic); });
          }
          lines.push("");
        });
      }
    }
    if (Array.isArray(ideas) && ideas.length > 0) {
      lines.push("## 通用搭配思路", "");
      ideas.forEach(function (idea) {
        lines.push("### " + (idea.principleName || "搭配原则"));
        if (Array.isArray(idea.detailedRules)) idea.detailedRules.forEach(function (rule) { lines.push("- " + rule); });
        lines.push("");
      });
    }
  } catch (_) { lines.push("分析数据解析异常，请查看原始分析结果。"); }
  return lines.join("\n");
}

/**
 * 服务端压缩图片：转为 JPEG，最大边不超过 maxPx
 */
async function compressImage(buffer, maxPx) {
  if (!sharp) return buffer;
  try {
    var metadata = await sharp(buffer).metadata();
    var maxDim = Math.max(metadata.width || 0, metadata.height || 0);
    if (maxDim <= maxPx && metadata.format === "jpeg") return buffer;
    var opts = {};
    if (maxDim > maxPx) {
      var scale = maxPx / maxDim;
      opts.width = Math.round((metadata.width || 0) * scale);
      opts.height = Math.round((metadata.height || 0) * scale);
      opts.fit = "inside";
      opts.withoutEnlargement = true;
    }
    return await sharp(buffer).resize(opts).jpeg({ quality: 85 }).toBuffer();
  } catch (err) {
    console.warn("服务端压缩失败:", err.message);
    return buffer;
  }
}

/**
 * 从 COS URL 提取 key
 */
function extractKey(url) {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch (_) { return null; }
}

/**
 * 读取 AI 设置（COS config/ai-settings.json）+ 环境变量
 * 返回 { aiUrl, aiModel, aiKey, aiPrompt }
 */
async function readAiSettings() {
  var aiUrl = process.env.SPARK_API_URL || "";
  var aiModel = process.env.SPARK_MODEL || "qwen3.6-plus";
  var aiKey = process.env.SPARK_API_KEY || process.env.DASHSCOPE_API_KEY || "";
  var aiPrompt = "";
  try {
    var configData = await new Promise(function (resolve, reject) {
      cos.getObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: "config/ai-settings.json",
      }, function (err, d) { if (err) reject(err); else resolve(d); });
    });
    var configBody = Buffer.isBuffer(configData.Body) ? configData.Body : Buffer.from(configData.Body);
    var settings = JSON.parse(configBody.toString("utf-8"));
    if (settings.aiUrl) aiUrl = settings.aiUrl;
    if (settings.aiModel) aiModel = settings.aiModel;
    if (settings.aiPrompt) aiPrompt = settings.aiPrompt;
  } catch (_) {}
  return { aiUrl: aiUrl, aiModel: aiModel, aiKey: aiKey, aiPrompt: aiPrompt };
}

// ============================================================
// 流式 AI 调用（SSE + 首帧检测 + 单 URL）
// ============================================================
async function streamAiResponse(url, body, headers) {
  var accumulatedContent = "";
  var firstChunkReceived = false;
  var FIRST_CHUNK_TIMEOUT = 15000;
  var FULL_TIMEOUT = 120000;
  var lastErrMsg = "";
  var startTime = Date.now();

  try {
    var controller = new AbortController();
    var fullTimeoutId = setTimeout(function () { controller.abort(); }, FULL_TIMEOUT);

    var response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(fullTimeoutId);
      var isAuth = response.status === 401 || response.status === 403;
      var errText = "";
      try { errText = await response.text(); } catch (_) {}
      console.warn("[AI] HTTP 错误:", response.status, errText.substring(0, 300));
      return { content: null, isAuthError: isAuth, error: "HTTP " + response.status + ": " + errText.substring(0, 200) };
    }

    if (!response.body) {
      clearTimeout(fullTimeoutId);
      return { content: null, isAuthError: false, error: "响应体为空" };
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    // 首帧超时检测：15s 内无任何数据到达 → 视为连接失败
    var firstChunkTimer = setTimeout(function () {
      if (!firstChunkReceived) {
        try { reader.cancel(); } catch (_) {}
        controller.abort();
        lastErrMsg = "首帧超时（15s 内未收到数据）";
      }
    }, FIRST_CHUNK_TIMEOUT);

    while (true) {
      var readResult = await reader.read();
      if (readResult.done) break;

      var chunk = decoder.decode(readResult.value, { stream: true });
      buffer += chunk;

      var lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (var li = 0; li < lines.length; li++) {
        var trimmed = lines[li].trim();
        if (!trimmed) continue;
        if (trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        var jsonStr = trimmed.slice(6);
        try {
          var parsed = JSON.parse(jsonStr);
          var delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || "";
          if (delta) {
            accumulatedContent += delta;
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              clearTimeout(firstChunkTimer);
              console.log("[AI] ✅ 首帧已到达（" + (Date.now() - startTime) + "ms）");
            }
          }
        } catch (_) {}
      }
    }

    clearTimeout(firstChunkTimer);
    clearTimeout(fullTimeoutId);

    if (!accumulatedContent) {
      return { content: null, isAuthError: false, error: "流式响应结束但未获得有效内容" };
    }

    console.log("[AI] ✅ 完整响应已接收（" + (Date.now() - startTime) + "ms, " + accumulatedContent.length + "字符）");
    return { content: accumulatedContent, isAuthError: false, error: null };
  } catch (err) {
    clearTimeout(fullTimeoutId);
    if (err.name === "AbortError") {
      return { content: null, isAuthError: false, error: lastErrMsg || "请求超时（120s）" };
    }
    return { content: null, isAuthError: false, error: err.message };
  }
}

// processSingleImage moved inline into GET handler below

// ============================================================
// Meilisearch 辅助函数
// ============================================================

async function searchJobs(params) {
  var res = await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
    params,
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );
  return res.data.hits || [];
}

async function updateJob(jobId, fields) {
  await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
    [{ id: jobId, ...fields }],
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );
}

// ============================================================
// 恢复卡住的任务（processing 状态 > 5 分钟）
// ============================================================
async function recoverStuckJobs() {
  try {
    var cutoff = Date.now() - 5 * 60 * 1000;
    var stuckHits = await searchJobs({
      q: "",
      filter: 'status = "processing" AND processingLock < ' + cutoff,
      limit: 10,
      sort: ["createdAt:asc"],
    });
    for (var j of stuckHits) {
      console.log("[recovery] 恢复卡住的任务:", j.id);
      await updateJob(j.id, { status: "pending", processingLock: 0, updatedAt: Date.now() });
    }
  } catch (_) {}
}

// ============================================================
// 读取提示词（优先从 AI 设置中的 aiPrompt，再文件，再内嵌）
// ============================================================
async function readPrompt() {
  var aiSettings = await readAiSettings();
  if (aiSettings.aiPrompt && aiSettings.aiPrompt.trim()) {
    console.log("[prompt] 使用自定义提示词（admin 设置）");
    return aiSettings.aiPrompt;
  }
  try {
    var filePrompt = fs.readFileSync(path.join(process.cwd(), "提示词.txt"), "utf-8");
    if (filePrompt && filePrompt.trim()) {
      console.log("[prompt] 使用提示词.txt");
      return filePrompt;
    }
  } catch (_) {}
  console.log("[prompt] 使用内嵌默认提示词");
  return EMBEDDED_PROMPT;
}

// ============================================================
// 主入口：批量处理（一次性下载所有图片 + 单次流式 AI 调用 + 所有图片共用一个 AI 回复）
// ============================================================
export async function GET(req) {
  try {
    // ---- Phase 0: 恢复所有卡住的任务 (> 5min) ----
    await recoverStuckJobs();

    // ---- Phase 1: 查找 pending 任务 ----
    var hits = await searchJobs({
      q: "",
      filter: 'status = "pending"',
      limit: 1,
      sort: ["createdAt:asc"],
    });
    if (hits.length === 0) {
      return Response.json({ success: true, message: "暂无可处理的任务" });
    }
    var job = hits[0];
    var jobId = job.id;
    var files = job.files || [];
    if (files.length === 0) {
      await updateJob(jobId, { status: "failed", results: [], updatedAt: Date.now() });
      return Response.json({ success: false, error: "任务文件列表为空" });
    }

    // ---- Phase 2: 锁定任务 ----
    await updateJob(jobId, {
      status: "processing",
      processingLock: Date.now(),
      aiPhase: "downloading",
      updatedAt: Date.now(),
    });

    // ---- Phase 3: 下载所有图片、压缩、上传压缩版 ----
    var promptContent = await readPrompt();
    var aiSettings = await readAiSettings();
    var bucketDomain = (process.env.COS_BUCKET || "")
      + ".cos." + (process.env.COS_REGION || "") + ".myqcloud.com";
    var imageList = []; // { compressed, compressedKey, url, spaceNames, idx }

    for (var i = 0; i < files.length; i++) {
      var fi = files[i];
      if (!fi.cosKey) {
        imageList.push({ compressed: null, compressedKey: "", url: "", spaceNames: fi.spaceNames || [], idx: i, error: "缺少 COS key" });
        continue;
      }
      console.log("[process] 下载图片 " + (i + 1) + "/" + files.length + ":", fi.cosKey);
      var dlData = await new Promise(function (resolve, reject) {
        cos.getObject({
          Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.cosKey,
        }, function (err, d) { if (err) reject(err); else resolve(d); });
      });
      var buf = Buffer.isBuffer(dlData.Body) ? dlData.Body : Buffer.from(dlData.Body);

      var compressed = await compressImage(buf, 1600);
      var compressedKey = fi.cosKey.replace(/^temp\//, "images/").replace(/\.[^.]+$/, ".jpg");

      await new Promise(function (resolve, reject) {
        cos.putObject({
          Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
          Key: compressedKey, Body: compressed,
          ACL: "public-read", ContentType: "image/jpeg",
        }, function (err) { if (err) reject(err); else resolve(); });
      });

      cos.deleteObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.cosKey,
      }, function () {});

      imageList.push({
        compressed: compressed,
        compressedKey: compressedKey,
        url: "https://" + bucketDomain + "/" + compressedKey,
        spaceNames: fi.spaceNames || [],
        idx: i,
        error: null,
      });
    }

    // ---- Phase 4: 构建批量提示词 + 一次 AI 调用（所有图片一起发送）----
    var promptLabels = imageList.map(function (img, idx) {
      if (img.error) return "图" + (idx + 1) + "：加载失败";
      var label = Array.isArray(img.spaceNames) && img.spaceNames.length > 0
        ? img.spaceNames.join("、") : "未命名空间";
      return "图" + (idx + 1) + "：" + label;
    });
    var fullPrompt = "本次分析共 " + imageList.length + " 张图片：\n"
      + promptLabels.join("\n") + "\n\n" + promptContent;

    var baseUrl = aiSettings.aiUrl.replace(/\/+$/, "");
    var chatUrl = baseUrl.indexOf("/chat/completions") === -1
      ? baseUrl + "/chat/completions" : baseUrl;

    var messages = [{
      role: "user",
      content: [{ type: "text", text: fullPrompt }],
    }];
    for (var img of imageList) {
      if (img.compressed && !img.error) {
        messages[0].content.push({
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64," + img.compressed.toString("base64") },
        });
      }
    }

    var openaiBody = {
      model: aiSettings.aiModel, stream: true, max_tokens: 8192,
      messages: messages,
    };

    var openaiHeaders = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + aiSettings.aiKey,
      "x-dashscope-api-key": aiSettings.aiKey,
    };

    await updateJob(jobId, { aiPhase: "waiting_first_chunk", updatedAt: Date.now() });
    console.log("[AI] 批量流式调用:", chatUrl, "图片数:", imageList.filter(function (x) { return !x.error; }).length);
    var streamResult = await streamAiResponse(chatUrl, openaiBody, openaiHeaders);

    if (!streamResult || !streamResult.content) {
      var aiErr = streamResult?.error || "AI 分析未返回有效内容";
      console.error("[AI] 批量分析失败:", aiErr);
      await updateJob(jobId, { status: "failed", aiPhase: "failed", results: [], error: aiErr, updatedAt: Date.now() });
      return Response.json({ success: false, error: aiErr });
    }

    var analysisRaw = streamResult.content;
    var analysis = tryParseJson(analysisRaw);
    if (!analysis) {
      console.error("[AI] 批量返回非 JSON:", analysisRaw.substring(0, 300));
      await updateJob(jobId, { status: "failed", aiPhase: "parse_failed", results: [], error: "AI 返回非 JSON", updatedAt: Date.now() });
      return Response.json({ success: false, error: "AI 返回非 JSON 格式" });
    }

    // ---- Phase 5: 逐个图片处理结果（MD、JSON、索引）----
    var results = [];
    for (var i = 0; i < imageList.length; i++) {
      var img = imageList[i];
      if (img.error) {
        results.push({ imageIndex: i, status: "failed", error: img.error, spaceNames: img.spaceNames });
        continue;
      }

      var imageIndex = i + 1; // 1-based，用于 (图N) 过滤
      var searchFields = extractSearchFields(analysis, imageIndex);
      var ts = Date.now() + i;

      // 5a. Markdown（只显示该图片关联的空间）
      var mdContent = buildMarkdown(analysis, img.url, ts, img.spaceNames, imageIndex);
      var basename = path.basename(img.compressedKey).replace(/\.[^.]+$/, "");
      var mdKey = "summaries/" + ts + "-" + basename + ".md";

      await new Promise(function (resolve, reject) {
        cos.putObject({
          Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
          Key: mdKey, Body: Buffer.from(mdContent, "utf-8"),
          ContentType: "text/markdown; charset=utf-8", ACL: "public-read",
        }, function (err) { if (err) reject(err); else resolve(); });
      });
      var mdUrl = "https://" + bucketDomain + "/" + mdKey;

      // 5b. 保存原始分析 JSON
      var rawKey = mdKey.replace(/\.md$/, ".json");
      cos.putObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
        Key: rawKey, Body: Buffer.from(analysisRaw, "utf-8"),
        ContentType: "application/json; charset=utf-8", ACL: "public-read",
      }, function () {});

      // 5c. 索引到 Meilisearch
      var doc = {
        id: ts, url: img.url, mdUrl: mdUrl,
        title: searchFields.title, summary: searchFields.summary,
        tags: searchFields.tags,
        spaceNames: img.spaceNames || [],
        spaceName: (img.spaceNames || []).join("、"),
        projectName: job.projectName || "",
        createdAt: ts, batchId: jobId || "",
      };

      try {
        await axios.post(
          process.env.MEILISEARCH_HOST + "/indexes/design_images/documents",
          [doc],
          {
            headers: {
              Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
              "Content-Type": "application/json",
            },
          }
        );
      } catch (err) {
        console.warn("Meilisearch 索引失败:", err.message);
      }

      results.push({
        imageIndex: i, status: "success",
        title: searchFields.title, summary: searchFields.summary,
        tags: searchFields.tags, mdUrl: mdUrl, url: img.url,
        spaceNames: img.spaceNames,
      });
    }

    // ---- Phase 6: 完成 ----
    var allSuccess = results.every(function (r) { return r.status === "success"; });
    await updateJob(jobId, {
      status: allSuccess ? "completed" : "failed",
      results: results,
      processingLock: 0,
      updatedAt: Date.now(),
    });

    return Response.json({
      success: allSuccess,
      message: allSuccess ? "批量处理完成" : "部分处理失败",
      jobId: jobId,
      results: results,
    });

  } catch (err) {
    console.error("队列处理失败:", err.message);
    try {
      if (typeof jobId !== "undefined") {
        await updateJob(jobId, { status: "failed", error: err.message, updatedAt: Date.now() });
      }
    } catch (_) {}
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
