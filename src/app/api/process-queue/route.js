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
  "**指令**：你是资深软装设计专家，请严格按照下方指定的JSON结构，对我上传的所有图片进行深度软装分析。",
  "**要求**：",
  "1.  我上传图片时会标注每张对应的空间名称（格式：图X：空间名称），请你严格按此对应生成spaceSoftDecorationAnalysis数组",
  "2.  不得新增、删除、修改任何顶级字段，所有内容必须填充到对应字段内",
  "3.  输出纯JSON代码，不包含任何额外说明文字、注释或Markdown格式",
  "4.  分析内容专业精准，覆盖风格定位、情感格调、硬装衔接、色彩轻重、材质呼应、单品搭配逻辑及通用思路",
  "5.  语言精简凝练，保留核心分析要点，避免冗余表述",
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

function extractSearchFields(analysis) {
  var title = "未命名图片", summary = "暂无总结", tags = [];
  try {
    var sd = analysis?.styleDefinition;
    var oes = analysis?.overallEmotionalStyle;
    if (sd?.coreStyle) title = sd.coreStyle + " 设计分析";
    var parts = [];
    if (oes?.coreTemperament) parts.push("核心气质：" + oes.coreTemperament);
    if (Array.isArray(oes?.detailedInterpretation)) parts.push.apply(parts, oes.detailedInterpretation);
    if (parts.length > 0) summary = parts.join("；");
    var tagSet = new Set();
    if (sd?.coreStyle) sd.coreStyle.split(/[、,，/\/\s]+/).forEach(function (t) { var c = t.trim(); if (c) tagSet.add(c); });
    if (sd?.designTechniques) sd.designTechniques.split(/[、,，/\/\s]+/).forEach(function (t) { var c = t.trim(); if (c) tagSet.add(c); });
    if (sd?.emotionalTone) sd.emotionalTone.split(/[、,，/\/\s]+/).forEach(function (t) { var c = t.trim(); if (c) tagSet.add(c); });
    if (Array.isArray(analysis?.spaceSoftDecorationAnalysis)) {
      analysis.spaceSoftDecorationAnalysis.forEach(function (s) {
        if (s?.spaceName) tagSet.add(s.spaceName);
        if (Array.isArray(s?.softDecorationItems)) s.softDecorationItems.forEach(function (i) { if (i?.itemName) tagSet.add(i.itemName); });
      });
    }
    tags = Array.from(tagSet).slice(0, 15);
  } catch (_) {}
  return { title: title, summary: summary, tags: tags };
}

function buildMarkdown(analysis, imageUrl, timestamp, spaceNames) {
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
      lines.push("## 空间软装分析", "");
      spaces.forEach(function (space, si) {
        lines.push("### " + (si + 1) + ". " + (space.spaceName || "未命名空间"));
        if (space.functionalAdaptation) lines.push("- **功能适配**: " + space.functionalAdaptation);
        if (space.hardwareBase) lines.push("- **硬装基础**: " + space.hardwareBase);
        if (Array.isArray(space.softDecorationItems)) {
          lines.push("", "**软装单品：**");
          space.softDecorationItems.forEach(function (item) { lines.push("- **" + item.itemName + "**: " + item.matchingLogic); });
        }
        lines.push("");
      });
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
// 处理单张图片
// ============================================================
async function processSingleImage(fileInfo, index, promptContent, batchId) {
  var result = { imageIndex: index, status: "pending", error: "", spaceNames: fileInfo.spaceNames || [] };
  var cosKey = fileInfo.cosKey;
  if (!cosKey) return { ...result, status: "failed", error: "缺少 COS key" };

  try {
    // 1. 从 COS 下载
    console.log("[process] 下载图片:", cosKey);
    var data = await new Promise(function (resolve, reject) {
      cos.getObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: cosKey,
      }, function (err, d) { if (err) reject(err); else resolve(d); });
    });

    var buffer = Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body);

    // 2. 压缩并转为 JPEG
    console.log("[process] 压缩图片:", cosKey);
    var compressed = await compressImage(buffer, 1600);
    var compressedKey = cosKey.replace(/^temp\//, "images/").replace(/\.[^.]+$/, ".jpg");

    await new Promise(function (resolve, reject) {
      cos.putObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: compressedKey,
        Body: compressed,
        ACL: "public-read",
        ContentType: "image/jpeg",
      }, function (err) { if (err) reject(err); else resolve(); });
    });

    cos.deleteObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: cosKey,
    }, function () {});

    var bucketDomain = (process.env.COS_BUCKET || "") + ".cos." + (process.env.COS_REGION || "") + ".myqcloud.com";
    var imageUrl = "https://" + bucketDomain + "/" + compressedKey;

    // 3. 构建提示词
    var spaceLabel = Array.isArray(fileInfo.spaceNames) && fileInfo.spaceNames.length > 0
      ? fileInfo.spaceNames.join("、") : "未命名空间";

    var promptForImage = "图 " + (index + 1) + "：" + spaceLabel + "\n\n" + promptContent;

    // 4. 调用 AI API
    console.log("[process] AI 分析:", compressedKey);
    var base64Image = compressed.toString("base64");
    var analysisRaw = "";
    var analysis = null;

    var aiSettings = await readAiSettings();

    // ========== 多 URL 兜底列表 ==========
    var FALLBACK_URLS = [
      aiSettings.aiUrl,
      "https://llm-28jx4qmqak31ymc9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      "https://ws-zwf60r4eps2lu9v2.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ].filter(function (u) { return u && u.length > 0; });

    var openaiBody = {
      model: aiSettings.aiModel, max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: promptForImage },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64Image } },
        ],
      }],
    };

    var openaiHeaders = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + aiSettings.aiKey,
      "x-dashscope-api-key": aiSettings.aiKey,
    };

    var lastErrMsg = "";
    var AI_TIMEOUT = 25000; // 每 URL 25s

    // ========== 带图片的 OpenAI 格式，遍历多个 URL ==========
    for (var u = 0; u < FALLBACK_URLS.length && !analysisRaw; u++) {
      var baseUrl = FALLBACK_URLS[u].replace(/\/+$/, "");
      var chatUrl = baseUrl.indexOf("/chat/completions") === -1
        ? baseUrl + "/chat/completions" : baseUrl;

      try {
        console.log("[AI] 尝试 URL" + (u + 1) + ": " + chatUrl);
        var sparkRes = await axios.post(chatUrl, openaiBody, {
          headers: openaiHeaders, timeout: AI_TIMEOUT,
        });
        if (sparkRes && sparkRes.status < 500) {
          var rd = sparkRes.data;
          if (rd && rd.choices && rd.choices[0] && rd.choices[0].message && rd.choices[0].message.content) {
            analysisRaw = rd.choices[0].message.content;
            break;
          }
          if (rd && rd.content && rd.content[0] && rd.content[0].text) {
            analysisRaw = rd.content[0].text;
            break;
          }
          if (rd && rd.error && rd.error.message) {
            lastErrMsg = "[URL" + (u + 1) + "] API 返回错误: " + rd.error.message;
          } else {
            lastErrMsg = "[URL" + (u + 1) + "] 响应格式无法识别: " + JSON.stringify(rd).substring(0, 200);
          }
        }
      } catch (err) {
        var statusCode = err.response?.status || 0;
        var msg = err.response?.data?.error?.message || err.response?.data?.message || err.message || "未知错误";
        lastErrMsg = "[URL" + (u + 1) + "] " + msg;
        console.warn("[AI] " + lastErrMsg);
        if (statusCode === 401 || statusCode === 403) break;
      }
    }

    if (analysisRaw) {
      analysis = tryParseJson(analysisRaw);
      if (!analysis) {
        console.warn("[AI] 返回内容非合法 JSON，原文前200字:", analysisRaw.substring(0, 200));
      }
    } else if (lastErrMsg) {
      console.error("[AI API 最终错误]", lastErrMsg);
      analysisRaw = lastErrMsg;
    }

    var searchFields;
    if (!analysis && lastErrMsg) {
      searchFields = { title: "AI 分析失败", summary: "错误: " + lastErrMsg.substring(0, 300), tags: [] };
    } else {
      searchFields = extractSearchFields(analysis);
    }
    var timestamp = Date.now() + index;

    // 5. 生成并上传 MD
    var mdContent = buildMarkdown(analysis, imageUrl, timestamp, fileInfo.spaceNames);
    var mdFilename = "summaries/" + timestamp + "-" + path.basename(compressedKey).replace(/\.[^.]+$/, "") + ".md";

    await new Promise(function (resolve, reject) {
      cos.putObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
        Key: mdFilename, Body: Buffer.from(mdContent, "utf-8"),
        ContentType: "text/markdown; charset=utf-8", ACL: "public-read",
      }, function (err, d) { if (err) reject(err); else resolve(d); });
    });
    var mdUrl = "https://" + bucketDomain + "/" + mdFilename;

    // 6. 保存原始分析 JSON
    if (analysisRaw) {
      var rawFilename = "summaries/" + timestamp + "-" + path.basename(compressedKey).replace(/\.[^.]+$/, "") + ".json";
      cos.putObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
        Key: rawFilename, Body: Buffer.from(analysisRaw, "utf-8"),
        ContentType: "application/json; charset=utf-8", ACL: "public-read",
      }, function () {});
    }

    // 7. 索引到 Meilisearch
    var document = {
      id: timestamp, url: imageUrl, mdUrl: mdUrl,
      title: searchFields.title, summary: searchFields.summary, tags: searchFields.tags,
      spaceNames: fileInfo.spaceNames || [], spaceName: (fileInfo.spaceNames || []).join("、"),
      createdAt: timestamp, batchId: batchId || "",
    };

    try {
      await axios.post(process.env.MEILISEARCH_HOST + "/indexes/design_images/documents", [document], {
        headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.warn("Meilisearch 索引失败:", err.message);
    }

    return {
      imageIndex: index, status: "success",
      title: searchFields.title, summary: searchFields.summary, tags: searchFields.tags,
      mdUrl: mdUrl, url: imageUrl, spaceNames: fileInfo.spaceNames,
    };
  } catch (err) {
    console.error("处理图片失败:", err.message);
    return { imageIndex: index, status: "failed", error: err.message, spaceNames: fileInfo.spaceNames || [] };
  }
}

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
// 自链机制：fire-and-forget 调用自身
// ============================================================
function selfChain() {
  try {
    var baseUrl = process.env.VERCEL_URL
      ? "https://" + process.env.VERCEL_URL
      : (process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000");
    fetch(baseUrl + "/api/process-queue", {
      method: "GET",
      headers: { "x-api-key": "internal" },
    }).catch(function () {});
  } catch (_) {}
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
      // 重置为 pending，清除 processingLock，以便重新处理
      await updateJob(j.id, {
        status: "pending",
        processingLock: 0,
        updatedAt: Date.now(),
      });
    }
  } catch (_) {}
}

// ============================================================
// 查找下一个可处理的任务
// ============================================================
async function findNextJob() {
  // 1. 优先 pending 任务
  var hits = await searchJobs({
    q: "",
    filter: 'status = "pending"',
    limit: 1,
    sort: ["createdAt:asc"],
  });
  if (hits.length > 0) return hits[0];

  // 2. 可重试的失败任务（状态为 failed，且 retryCount < maxRetries，且 nextRetryAt <= now）
  var retryHits = await searchJobs({
    q: "",
    filter: 'status = "failed" AND retryCount < maxRetries',
    limit: 5,
    sort: ["nextRetryAt:asc"],
  });
  var now = Date.now();
  for (var j of retryHits) {
    if ((j.nextRetryAt || 0) <= now) return j;
  }

  return null;
}

// ============================================================
// 确定任务最终状态并更新
// ============================================================
async function finalizeJob(job, results) {
  var allSuccess = results.every(function (r) { return r && r.status === "success"; });
  var jobId = job.id;

  if (allSuccess) {
    await updateJob(jobId, {
      status: "completed",
      results: results,
      processingLock: 0,
      updatedAt: Date.now(),
    });
  } else {
    var retryCount = (job.retryCount || 0) + 1;
    var maxRetries = job.maxRetries || 2;
    if (retryCount >= maxRetries) {
      await updateJob(jobId, {
        status: "failed",
        retryCount: retryCount,
        results: results,
        processingLock: 0,
        updatedAt: Date.now(),
      });
    } else {
      var nextRetryAt = Date.now() + 5 * 60 * 1000;
      await updateJob(jobId, {
        status: "failed",
        retryCount: retryCount,
        nextRetryAt: nextRetryAt,
        results: results,
        processingLock: 0,
        updatedAt: Date.now(),
      });
    }
  }
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
// 主入口：单图自链处理
// ============================================================
export async function GET(req) {
  try {
    // ---- Phase 0: 恢复所有卡住的任务 (> 5min) ----
    await recoverStuckJobs();

    // ---- Phase 1: 查找下一个可处理的任务 ----
    var job = await findNextJob();
    if (!job) {
      return Response.json({ success: true, message: "暂无可处理的任务" });
    }

    var jobId = job.id;
    var files = job.files || [];
    var results = (job.results || []).slice();

    // ---- Phase 2: 锁定任务 ----
    // 记录 processingLock 时间戳，用于 stuck 检测
    await updateJob(jobId, {
      status: "processing",
      processingLock: Date.now(),
      updatedAt: Date.now(),
    });

    // ---- Phase 3: 查找第一张未处理的图片 ----
    var nextIndex = -1;
    for (var i = 0; i < files.length; i++) {
      if (!results[i] || results[i].status !== "success") {
        nextIndex = i;
        break;
      }
    }

    if (nextIndex === -1) {
      // 所有图片已由其它调用完成
      await finalizeJob(job, results);
      return Response.json({ success: true, message: "所有图片已处理完毕" });
    }

    // ---- Phase 4: 读取提示词 ----
    var promptContent = await readPrompt();

    // ---- Phase 5: 处理这张图片 ----
    console.log("[process-queue] 处理任务", jobId, "图片", nextIndex + 1, "/", files.length);
    var result = await processSingleImage(files[nextIndex], nextIndex, promptContent, jobId);
    results[nextIndex] = result;

    // ---- Phase 6: 保存进度 ----
    var allDone = results.every(function (r) { return r && r.status && r.status !== "pending"; });
    if (allDone) {
      await finalizeJob(job, results);
    } else {
      await updateJob(jobId, {
        results: results,
        status: "processing",
        processingLock: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // ---- Phase 7: 自链（还有更多图片要处理） ----
    if (!allDone) {
      selfChain();
    }

    // ---- Phase 8: 返回结果 ----
    var successCount = results.filter(function (r) { return r && r.status === "success"; }).length;
    var failCount = results.filter(function (r) { return r && r.status === "failed"; }).length;

    return Response.json({
      success: true,
      message: "已完成 " + (nextIndex + 1) + "/" + files.length + "：" + successCount + " 成功，" + failCount + " 失败",
      jobId: jobId,
      result: result,
      allDone: !!allDone,
    });
  } catch (err) {
    console.error("队列处理失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
