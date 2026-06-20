/**
 * 共享处理流水线 —— SSE 实时流 + 后台断点续跑 的单一事实来源。
 *
 * 两个调用方：
 *   - process-stream (SSE)：传入 onEvent，把每个阶段实时推给前端
 *   - process-queue  (后台)：onEvent 为空，静默跑完用于恢复/续跑
 *
 * 断点续跑（幂等）：
 *   - 每张图压缩完 → 存 file.compressedKey（续跑时直接从 images/ 下载，不再压缩）
 *   - AI 调用完成 → 存 job.aiRaw（续跑时跳过 AI，直接写结果 —— 省钱 + 守"一次批量调用"规则）
 *   - 文档 id = jobId*1000+index（稳定，续跑重复写为幂等 upsert）
 */

import COS from "cos-nodejs-sdk-v5";
import axios from "axios";
import path from "path";
import fs from "fs";

// ---- sharp（原生二进制模块，需在 next.config.mjs 外部化）----
var sharp = null;
try {
  sharp = require("sharp");
} catch (err) {
  console.warn("sharp 加载失败，服务端压缩不可用:", err && err.message);
}

// ============================================================
// 工具函数
// ============================================================

function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  var m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch (_) {} }
  var b = text.match(/\{[\s\S]*\}/);
  if (b) { try { return JSON.parse(b[0]); } catch (_) {} }
  return null;
}

function extractKey(url) {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch (_) { return null; }
}

/** 稳定的文档 id：jobId*1000 + 图片下标，续跑重复写为幂等 upsert */
function stableDocId(jobId, imageIndex) {
  var base = parseInt(jobId, 10) || Date.now();
  return base * 1000 + imageIndex;
}

/**
 * 提取搜索字段（title / summary / tags）
 * imageIndex: 1-based。批量模式下只提取匹配 (图N) 的空间数据
 */
function extractSearchFields(analysis, imageIndex) {
  var title = "未命名图片", summary = "暂无总结", tags = [];
  try {
    var sd = analysis && analysis.styleDefinition;
    var oes = analysis && analysis.overallEmotionalStyle;
    var cds = analysis && analysis.colorDesignSummary;
    if (sd && sd.coreStyle) title = sd.coreStyle;
    var parts = [];
    if (oes && oes.coreTemperament) parts.push("核心气质：" + oes.coreTemperament);
    if (Array.isArray(oes && oes.detailedInterpretation)) parts.push.apply(parts, oes.detailedInterpretation);
    if (parts.length > 0) summary = parts.join("；");
    var tagSet = new Set();
    var splitInto = function (text) {
      if (!text) return;
      String(text).split(/[、,，/\/\s]+/).forEach(function (t) {
        var c = t.trim(); if (c) tagSet.add(c);
      });
    };
    if (sd) { splitInto(sd.coreStyle); splitInto(sd.designTechniques); splitInto(sd.emotionalTone); }
    if (cds && cds.coreApplication) splitInto(cds.coreApplication);
    if (Array.isArray(analysis && analysis.spaceSoftDecorationAnalysis)) {
      analysis.spaceSoftDecorationAnalysis.forEach(function (s) {
        if (imageIndex) {
          var suffix = "（图" + imageIndex + "）";
          var suffixAlt = "(图" + imageIndex + ")";
          if (!s || !s.spaceName || (s.spaceName.indexOf(suffix) === -1 && s.spaceName.indexOf(suffixAlt) === -1)) return;
        }
        if (s && s.spaceName) tagSet.add(s.spaceName);
        if (Array.isArray(s && s.softDecorationItems)) s.softDecorationItems.forEach(function (i) { if (i && i.itemName) tagSet.add(i.itemName); });
        if (Array.isArray(s && s.materials)) s.materials.forEach(function (m) { if (m) tagSet.add(m); });
      });
    }
    tags = Array.from(tagSet).slice(0, 15);
  } catch (_) {}
  return { title: title, summary: summary, tags: tags };
}

/**
 * 构建单张图的 Markdown（imageIndex 过滤属于该图的空间）
 */
function buildMarkdown(analysis, imageUrl, timestamp, spaceNames, imageIndex) {
  var lines = [];
  try {
    var sd = analysis && analysis.styleDefinition;
    var oes = analysis && analysis.overallEmotionalStyle;
    var cds = analysis && analysis.colorDesignSummary;
    var spaces = analysis && analysis.spaceSoftDecorationAnalysis;
    var ideas = analysis && analysis.generalMatchingIdeas;
    var spaceLabel = Array.isArray(spaceNames) && spaceNames.length > 0 ? spaceNames.join("、") : "";
    lines.push("# " + ((sd && sd.coreStyle) || spaceLabel || "设计分析"));
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
 * 返回 { buffer, originalSize, compressedSize, sharpUsed }
 */
async function compressImage(buffer, maxPx) {
  var originalSize = buffer.length;
  if (!sharp) {
    return { buffer: buffer, originalSize: originalSize, compressedSize: originalSize, sharpUsed: false };
  }
  try {
    var metadata = await sharp(buffer).metadata();
    var maxDim = Math.max(metadata.width || 0, metadata.height || 0);
    if (maxDim <= maxPx && metadata.format === "jpeg") {
      return { buffer: buffer, originalSize: originalSize, compressedSize: originalSize, sharpUsed: true };
    }
    var opts = {};
    if (maxDim > maxPx) {
      var scale = maxPx / maxDim;
      opts.width = Math.round((metadata.width || 0) * scale);
      opts.height = Math.round((metadata.height || 0) * scale);
      opts.fit = "inside";
      opts.withoutEnlargement = true;
    }
    var out = await sharp(buffer).resize(opts).jpeg({ quality: 85 }).toBuffer();
    return { buffer: out, originalSize: originalSize, compressedSize: out.length, sharpUsed: true };
  } catch (err) {
    console.warn("服务端压缩失败:", err.message);
    return { buffer: buffer, originalSize: originalSize, compressedSize: originalSize, sharpUsed: false };
  }
}

// ============================================================
// AI 设置 / 提示词
// ============================================================

async function makeCos() {
  return new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY });
}

async function readAiSettings(cos) {
  var aiUrl = process.env.SPARK_API_URL || "";
  var aiModel = process.env.SPARK_MODEL || "qwen3.6-plus";
  var aiKey = process.env.SPARK_API_KEY || process.env.DASHSCOPE_API_KEY || "";
  var aiPrompt = "";
  try {
    var configData = await new Promise(function (resolve, reject) {
      cos.getObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: "config/ai-settings.json",
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

async function readPrompt(cos, aiSettings) {
  if (aiSettings.aiPrompt && aiSettings.aiPrompt.trim()) {
    return aiSettings.aiPrompt;
  }
  try {
    var filePrompt = fs.readFileSync(path.join(process.cwd(), "提示词.txt"), "utf-8");
    if (filePrompt && filePrompt.trim()) return filePrompt;
  } catch (_) {}
  return null; // 由调用方回退到内嵌提示词
}

// ============================================================
// 流式 AI 调用（SSE + 首帧检测 + onChunk 回调 + 读秒）
// ============================================================

/**
 * @param {object} opts
 *   - onChunk(text)        每收到一段 delta 触发（用于实时推送内容）
 *   - onFirstFrame(ms)     首帧到达
 *   - onTailWait(elapsedSec, sinceFirstSec)  读秒心跳（每秒一次，首帧后开始）
 */
async function streamAiResponse(url, body, headers, opts) {
  opts = opts || {};
  var onChunk = opts.onChunk || function () {};
  var onFirstFrame = opts.onFirstFrame || function () {};
  var onTailWait = opts.onTailWait || function () {};
  var accumulatedContent = "";
  var firstChunkReceived = false;
  var FIRST_CHUNK_TIMEOUT = 20000;
  var FULL_TIMEOUT = 250000;
  var lastErrMsg = "";
  var startTime = Date.now();
  var firstFrameMs = 0;

  // 读秒心跳：首帧后每秒触发一次
  var tailTimer = null;

  try {
    var controller = new AbortController();
    var fullTimeoutId = setTimeout(function () { controller.abort(); }, FULL_TIMEOUT);

    var response = await fetch(url, {
      method: "POST", headers: headers, body: JSON.stringify(body), signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(fullTimeoutId);
      var isAuth = response.status === 401 || response.status === 403;
      var errText = ""; try { errText = await response.text(); } catch (_) {}
      return { content: null, isAuthError: isAuth, error: "HTTP " + response.status + ": " + errText.substring(0, 200) };
    }
    if (!response.body) {
      clearTimeout(fullTimeoutId);
      return { content: null, isAuthError: false, error: "响应体为空" };
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    var firstChunkTimer = setTimeout(function () {
      if (!firstChunkReceived) {
        try { reader.cancel(); } catch (_) {}
        controller.abort();
        lastErrMsg = "首帧超时（20s 内未收到数据）";
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
        if (!trimmed || trimmed === "data: [DONE]" || trimmed.indexOf("data: ") !== 0) continue;
        var jsonStr = trimmed.slice(6);
        try {
          var parsed = JSON.parse(jsonStr);
          var delta = (parsed.choices && parsed.choices[0] && (parsed.choices[0].delta || {}).content)
            || (parsed.choices && parsed.choices[0] && (parsed.choices[0].message || {}).content) || "";
          if (delta) {
            accumulatedContent += delta;
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              firstFrameMs = Date.now() - startTime;
              clearTimeout(firstChunkTimer);
              onFirstFrame(firstFrameMs);
              // 启动读秒心跳
              tailTimer = setInterval(function () {
                onTailWait(Math.floor((Date.now() - startTime) / 1000), Math.floor((Date.now() - startTime - firstFrameMs) / 1000));
              }, 1000);
            }
            onChunk(delta);
          }
        } catch (_) {}
      }
    }

    clearTimeout(firstChunkTimer);
    clearTimeout(fullTimeoutId);
    if (tailTimer) clearInterval(tailTimer);

    if (!accumulatedContent) {
      return { content: null, isAuthError: false, error: "流式响应结束但未获得有效内容" };
    }
    return { content: accumulatedContent, isAuthError: false, error: null, firstFrameMs: firstFrameMs };
  } catch (err) {
    clearTimeout(fullTimeoutId);
    if (tailTimer) clearInterval(tailTimer);
    if (err.name === "AbortError") {
      return { content: null, isAuthError: false, error: lastErrMsg || "请求超时（250s）" };
    }
    return { content: null, isAuthError: false, error: err.message };
  }
}

// ============================================================
// Meilisearch 辅助
// ============================================================

async function updateJob(jobId, fields) {
  await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
    [Object.assign({ id: jobId }, fields)],
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );
}

// ============================================================
// 主流水线
// ============================================================

/**
 * 运行完整流水线（带断点续跑 + 事件回调）。
 * @param {object} job 任务文档
 * @param {object} opts
 *   - onEvent(type, data)  每个阶段触发（type 见下方）
 *   - heartbeat()          定期调用（SSE 模式下用于刷新 processingLock，防被恢复机制误抢）
 * @returns {Promise<{success:boolean, results:Array, error:?string}>}
 */
export async function runPipeline(job, opts) {
  opts = opts || {};
  var onEvent = opts.onEvent || function () {};
  var heartbeat = opts.heartbeat || function () {};
  var jobId = job.id;
  var files = job.files || [];
  var cos = await makeCos();
  var aiSettings = await readAiSettings(cos);
  var bucketDomain = (process.env.COS_BUCKET || "") + ".cos." + (process.env.COS_REGION || "") + ".myqcloud.com";

  var results = Array.isArray(job.results) ? job.results.slice() : [];

  // ============ Phase 1: 下载 + 压缩（带断点续跑）============
  var imageList = []; // { compressed, compressedKey, url, spaceNames, idx, originalSize, compressedSize, sharpUsed, error }
  for (var i = 0; i < files.length; i++) {
    heartbeat();
    var fi = files[i];
    if (!fi || !fi.cosKey) {
      imageList.push({ compressed: null, compressedKey: "", url: "", spaceNames: (fi && fi.spaceNames) || [], idx: i, error: "缺少 COS key" });
      onEvent("stage", { stage: "skip", index: i + 1, total: files.length, reason: "缺少 COS key" });
      continue;
    }

    // 断点续跑：已有 compressedKey → 直接从 images/ 下载已压缩版（不再压缩）
    if (fi.compressedKey) {
      onEvent("stage", { stage: "resuming", index: i + 1, total: files.length });
      try {
        var resumeData = await new Promise(function (resolve, reject) {
          cos.getObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.compressedKey },
            function (err, d) { if (err) reject(err); else resolve(d); });
        });
        var resumeBuf = Buffer.isBuffer(resumeData.Body) ? resumeData.Body : Buffer.from(resumeData.Body);
        imageList.push({
          compressed: resumeBuf, compressedKey: fi.compressedKey,
          url: "https://" + bucketDomain + "/" + fi.compressedKey,
          spaceNames: fi.spaceNames || [], idx: i,
          originalSize: fi.originalSize || resumeBuf.length, compressedSize: resumeBuf.length,
          sharpUsed: true, error: null,
        });
        continue;
      } catch (err) {
        // 已压缩版丢了 → 回退到重新下载+压缩
        console.warn("[resume] 已压缩版丢失，回退重压缩:", fi.compressedKey, err.message);
      }
    }

    onEvent("stage", { stage: "downloading", index: i + 1, total: files.length });
    try {
      var dlData = await new Promise(function (resolve, reject) {
        cos.getObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.cosKey },
          function (err, d) { if (err) reject(err); else resolve(d); });
      });
      var buf = Buffer.isBuffer(dlData.Body) ? dlData.Body : Buffer.from(dlData.Body);
      var originalSize = buf.length;

      onEvent("stage", { stage: "compressing", index: i + 1, total: files.length });
      var comp = await compressImage(buf, 1600);
      var compressedKey = fi.cosKey.replace(/^temp\//, "images/").replace(/\.[^.]+$/, ".jpg");

      await new Promise(function (resolve, reject) {
        cos.putObject({
          Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
          Key: compressedKey, Body: comp.buffer, ACL: "public-read", ContentType: "image/jpeg",
        }, function (err) { if (err) reject(err); else resolve(); });
      });

      // 删除临时原图
      cos.deleteObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.cosKey }, function () {});

      // 写入断点 checkpoint：压缩后的 key 存进 file 记录
      var updatedFiles = (job.files || []).map(function (f, idx) {
        if (idx !== i) return f;
        return Object.assign({}, f, {
          compressedKey: compressedKey,
          originalSize: originalSize,
          compressedSize: comp.compressedSize,
        });
      });
      await updateJob(jobId, { files: updatedFiles });
      job.files = updatedFiles;

      onEvent("compressed", {
        index: i + 1, total: files.length,
        originalSize: originalSize, compressedSize: comp.compressedSize, sharp: comp.sharpUsed,
      });

      imageList.push({
        compressed: comp.buffer, compressedKey: compressedKey,
        url: "https://" + bucketDomain + "/" + compressedKey,
        spaceNames: fi.spaceNames || [], idx: i,
        originalSize: originalSize, compressedSize: comp.compressedSize,
        sharpUsed: comp.sharpUsed, error: null,
      });
    } catch (err) {
      console.warn("[process] 图片处理失败 " + (i + 1) + ":", err.message);
      imageList.push({ compressed: null, compressedKey: "", url: "", spaceNames: fi.spaceNames || [], idx: i, error: err.message });
      onEvent("stage", { stage: "compress_failed", index: i + 1, total: files.length, error: err.message });
    }
  }

  // ============ Phase 2: AI 调用（一次批量调用，带断点续跑）============
  var analysisRaw = job.aiRaw || null;
  var analysis = null;
  var firstFrameMs = 0;

  if (analysisRaw) {
    // 断点续跑：已有 AI 结果 → 直接复用，跳过 AI 调用
    analysis = tryParseJson(analysisRaw);
    onEvent("stage", { stage: "ai_resumed", note: "复用已保存的 AI 结果，跳过调用" });
  } else {
    var validImages = imageList.filter(function (x) { return !x.error; });
    var promptContent = await readPrompt(cos, aiSettings);
    if (!promptContent) {
      promptContent = getDefaultPrompt();
    }

    var promptLabels = imageList.map(function (img, idx) {
      if (img.error) return "图" + (idx + 1) + "：加载失败";
      var label = Array.isArray(img.spaceNames) && img.spaceNames.length > 0 ? img.spaceNames.join("、") : "未命名空间";
      return "图" + (idx + 1) + "：" + label;
    });
    var fullPrompt = "本次分析共 " + imageList.length + " 张图片：\n" + promptLabels.join("\n") + "\n\n" + promptContent;

    var baseUrl = aiSettings.aiUrl.replace(/\/+$/, "");
    var chatUrl = baseUrl.indexOf("/chat/completions") === -1 ? baseUrl + "/chat/completions" : baseUrl;

    var messages = [{ role: "user", content: [{ type: "text", text: fullPrompt }] }];
    var payloadBytes = 0;
    for (var img of imageList) {
      if (img.compressed && !img.error) {
        var b64 = img.compressed.toString("base64");
        payloadBytes += b64.length;
        messages[0].content.push({
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64," + b64 },
        });
      }
    }

    var openaiBody = { model: aiSettings.aiModel, stream: true, max_tokens: 8192, messages: messages };
    var openaiHeaders = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + aiSettings.aiKey,
      "x-dashscope-api-key": aiSettings.aiKey,
    };

    onEvent("ai_submit", { totalImages: validImages.length, payloadBytes: payloadBytes, model: aiSettings.aiModel });
    heartbeat();

    var streamResult = await streamAiResponse(chatUrl, openaiBody, openaiHeaders, {
      onFirstFrame: function (ms) { onEvent("first_frame", { elapsedMs: ms }); firstFrameMs = ms; },
      onChunk: function (delta) { onEvent("content", { chunk: delta }); heartbeat(); },
      onTailWait: function (elapsedSec, sinceFirstSec) { onEvent("tail_wait", { elapsedSec: elapsedSec, sinceFirstSec: sinceFirstSec }); },
    });

    if (!streamResult || !streamResult.content) {
      var aiErr = (streamResult && streamResult.error) || "AI 分析未返回有效内容";
      onEvent("error", { stage: "ai", message: aiErr });
      return { success: false, results: results, error: aiErr };
    }

    analysisRaw = streamResult.content;
    analysis = tryParseJson(analysisRaw);
    if (!analysis) {
      onEvent("error", { stage: "parse", message: "AI 返回非 JSON 格式" });
      return { success: false, results: results, error: "AI 返回非 JSON 格式" };
    }

    // 写入断点 checkpoint：保存原始 AI 结果（续跑时跳过 AI 调用）
    await updateJob(jobId, { aiRaw: analysisRaw, aiFirstFrameMs: firstFrameMs });
  }

  // ============ Phase 3: 逐图写结果（MD / JSON / 索引，幂等）============
  for (var j = 0; j < imageList.length; j++) {
    heartbeat();
    var img2 = imageList[j];
    if (img2.error) {
      results[j] = { imageIndex: j, status: "failed", error: img2.error, spaceNames: img2.spaceNames };
      onEvent("image_done", { index: j + 1, total: imageList.length, status: "failed", error: img2.error });
      continue;
    }

    var imageIndex = j + 1; // 1-based，用于 (图N) 过滤
    var searchFields = extractSearchFields(analysis, imageIndex);
    var docId = stableDocId(jobId, j);
    var ts = docId;

    var mdContent = buildMarkdown(analysis, img2.url, ts, img2.spaceNames, imageIndex);
    var basename = path.basename(img2.compressedKey).replace(/\.[^.]+$/, "");
    var mdKey = "summaries/" + ts + "-" + basename + ".md";

    try {
      await new Promise(function (resolve, reject) {
        cos.putObject({
          Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
          Key: mdKey, Body: Buffer.from(mdContent, "utf-8"),
          ContentType: "text/markdown; charset=utf-8", ACL: "public-read",
        }, function (err) { if (err) reject(err); else resolve(); });
      });
    } catch (err) {
      console.warn("MD 写入失败:", err.message);
    }
    var mdUrl = "https://" + bucketDomain + "/" + mdKey;

    // 原始分析 JSON
    var rawKey = mdKey.replace(/\.md$/, ".json");
    cos.putObject({
      Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
      Key: rawKey, Body: Buffer.from(analysisRaw, "utf-8"),
      ContentType: "application/json; charset=utf-8", ACL: "public-read",
    }, function () {});

    // 索引到 Meilisearch（幂等 upsert，id 稳定）
    var doc = {
      id: docId, url: img2.url, mdUrl: mdUrl,
      title: searchFields.title, summary: searchFields.summary, tags: searchFields.tags,
      spaceNames: img2.spaceNames || [],
      spaceName: (img2.spaceNames || []).join("、"),
      projectName: job.projectName || "",
      createdAt: ts, batchId: jobId || "",
    };
    try {
      await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/design_images/documents", [doc],
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.warn("Meilisearch 索引失败:", err.message);
    }

    results[j] = {
      imageIndex: j, status: "success",
      title: searchFields.title, summary: searchFields.summary,
      tags: searchFields.tags, mdUrl: mdUrl, url: img2.url, spaceNames: img2.spaceNames,
    };
    onEvent("image_done", { index: j + 1, total: imageList.length, status: "success", title: searchFields.title });
  }

  var allSuccess = results.every(function (r) { return r && r.status === "success"; });
  return { success: allSuccess, results: results, error: allSuccess ? null : "部分图片处理失败" };
}

// ============================================================
// 内嵌默认提示词（与提示词.txt 一致，作为最终回退）
// ============================================================
export function getDefaultPrompt() {
  return [
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
    JSON.stringify({
      styleDefinition: { coreStyle: "", designTechniques: "", emotionalTone: "" },
      overallEmotionalStyle: { coreTemperament: "", detailedInterpretation: [] },
      colorDesignSummary: { coreApplication: "", coreLogic: "", coreTechniques: [], balanceLogic: [] },
      spaceSoftDecorationAnalysis: [],
      generalMatchingIdeas: [],
    }, null, 2),
  ].join("\n");
}
