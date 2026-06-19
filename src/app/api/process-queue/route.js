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
 * 处理单张图片：压缩 → AI 分析 → 保存结果
 */
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

    // 4. 调用 AI API（智能识别多种格式）
    console.log("[process] AI 分析:", compressedKey);
    var base64Image = compressed.toString("base64");
    var analysisRaw = "";
    var analysis = null;

    // 先尝试从 COS 读取 AI 设置，再回退到环境变量
    var aiUrl = process.env.SPARK_API_URL || "";
    var aiModel = process.env.SPARK_MODEL || "qwen3.6-plus";
    var aiKey = process.env.SPARK_API_KEY || process.env.DASHSCOPE_API_KEY || "";
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
    } catch (_) {}

    // ========== 多 URL 兜底列表（按测试结果排序） ==========
    // 已确认有效的 URL + OpenAI 格式
    var FALLBACK_URLS = [
      aiUrl,  // 用户配置/环境变量中的 URL（优先）
      "https://llm-28jx4qmqak31ymc9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      "https://ws-zwf60r4eps2lu9v2.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ].filter(function (u) { return u && u.length > 0; });

    // OpenAI Chat 格式（已确认可用）— 带图片
    var openaiBodyWithImage = {
      model: aiModel, max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: promptForImage },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64Image } },
        ],
      }],
    };
    // 纯文本兜底（某些模型不支持图片）
    var openaiBodyTextOnly = {
      model: aiModel, max_tokens: 4096,
      messages: [{
        role: "user",
        content: promptForImage,
      }],
    };
    var openaiHeadersDual = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + aiKey,
      "x-dashscope-api-key": aiKey,
    };

    var sparkRes = null;
    var lastErrMsg = "";
    var AI_TIMEOUT_FIRST = 25000; // 第一轮(带图片)每URL 25s，快速跳过慢节点
    var AI_TIMEOUT_SECOND = 40000; // 第二轮(纯文本) 40s，比带图片快

    // ========== 第一轮：带图片的 OpenAI 格式，遍历多个 URL ==========
    for (var u = 0; u < FALLBACK_URLS.length && !analysisRaw; u++) {
      var baseUrl = FALLBACK_URLS[u].replace(/\/+$/, "");
      var chatUrl = baseUrl.indexOf("/chat/completions") === -1
        ? baseUrl + "/chat/completions" : baseUrl;

      try {
        console.log("[AI] 尝试 URL" + (u + 1) + " 带图片: " + chatUrl);
        sparkRes = await axios.post(chatUrl, openaiBodyWithImage, {
          headers: openaiHeadersDual, timeout: AI_TIMEOUT_FIRST,
        });
        if (sparkRes && sparkRes.status < 500) {
          var rd = sparkRes.data;
          if (rd && rd.choices && rd.choices[0] && rd.choices[0].message && rd.choices[0].message.content) {
            analysisRaw = rd.choices[0].message.content;
            break;
          }
          // Anthropic 格式响应（极低概率但保留）
          if (rd && rd.content && rd.content[0] && rd.content[0].text) {
            analysisRaw = rd.content[0].text;
            break;
          }
          if (rd && rd.error && rd.error.message) {
            lastErrMsg = "[URL" + (u + 1) + " 带图片] API 返回错误: " + rd.error.message;
          } else {
            lastErrMsg = "[URL" + (u + 1) + " 带图片] 响应格式无法识别: " + JSON.stringify(rd).substring(0, 200);
          }
        }
      } catch (err) {
        var statusCode = err.response?.status || 0;
        var msg = err.response?.data?.error?.message || err.response?.data?.message || err.message || "未知错误";
        lastErrMsg = "[URL" + (u + 1) + " 带图片] " + msg;
        console.warn("[AI] " + lastErrMsg);
        if (statusCode === 401 || statusCode === 403) break; // 认证错误直接终止
      }
    }

    // ========== 第二轮：如果带图片失败，尝试纯文本 ==========
    if (!analysisRaw) {
      for (var u2 = 0; u2 < FALLBACK_URLS.length && !analysisRaw; u2++) {
        var baseUrl2 = FALLBACK_URLS[u2].replace(/\/+$/, "");
        var chatUrl2 = baseUrl2.indexOf("/chat/completions") === -1
          ? baseUrl2 + "/chat/completions" : baseUrl2;

        try {
          console.log("[AI] 尝试 URL" + (u2 + 1) + " 纯文本: " + chatUrl2);
          sparkRes = await axios.post(chatUrl2, openaiBodyTextOnly, {
            headers: openaiHeadersDual, timeout: AI_TIMEOUT_SECOND,
          });
          if (sparkRes && sparkRes.status < 500) {
            var rd2 = sparkRes.data;
            if (rd2 && rd2.choices && rd2.choices[0] && rd2.choices[0].message && rd2.choices[0].message.content) {
              analysisRaw = rd2.choices[0].message.content;
              break;
            }
            if (rd2 && rd2.content && rd2.content[0] && rd2.content[0].text) {
              analysisRaw = rd2.content[0].text;
              break;
            }
            if (rd2 && rd2.error && rd2.error.message) {
              lastErrMsg = "[URL" + (u2 + 1) + " 纯文本] API 返回错误: " + rd2.error.message;
            } else {
              lastErrMsg = "[URL" + (u2 + 1) + " 纯文本] 响应格式无法识别: " + JSON.stringify(rd2).substring(0, 200);
            }
          }
        } catch (err) {
          var statusCode2 = err.response?.status || 0;
          var msg2 = err.response?.data?.error?.message || err.response?.data?.message || err.message || "未知错误";
          lastErrMsg = "[URL" + (u2 + 1) + " 纯文本] " + msg2;
          console.warn("[AI] " + lastErrMsg);
          if (statusCode2 === 401 || statusCode2 === 403) break;
        }
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

    // AI 失败时将错误信息展示给用户
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

    var mdResult = await new Promise(function (resolve, reject) {
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
// 主入口：处理待处理队列
// ============================================================
export async function GET(req) {
  var bucket = process.env.COS_BUCKET;
  var region = process.env.COS_REGION;

  try {
    // 1. 查下一个 pending 任务
    var searchRes = await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
      { q: "", filter: 'status = "pending"', limit: 1, sort: ["createdAt:asc"] },
      { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
    );

    var hits = searchRes.data.hits || [];
    if (hits.length === 0) {
      var retryRes = await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
        { q: "", filter: 'status = "failed" AND retryCount < maxRetries', limit: 1, sort: ["nextRetryAt:asc"] },
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
      );
      hits = retryRes.data.hits || [];
      if (hits.length > 0) {
        var now = Date.now();
        hits = hits.filter(function (j) { return (j.nextRetryAt || 0) <= now; });
        if (hits.length === 0) {
          return Response.json({ success: true, message: "暂无可处理的任务" });
        }
      }
    }

    if (hits.length === 0) {
      return Response.json({ success: true, message: "暂无可处理的任务" });
    }

    var job = hits[0];
    var jobId = job.id;

    // 2. 锁定任务
    await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
      [{ id: jobId, status: "processing", updatedAt: Date.now() }],
      { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
    );

    // 3. 读取提示词
    var promptContent = "";
    try {
      promptContent = fs.readFileSync(path.join(process.cwd(), "提示词.txt"), "utf-8");
    } catch (_) {
      promptContent = EMBEDDED_PROMPT;
    }

    var files = job.files || [];
    var results = (job.results || []).slice();
    var allSuccess = true;

    // 4. 处理图片
    if (job.type === "batch") {
      for (var fi = 0; fi < files.length; fi++) {
        if (results[fi] && results[fi].status === "success") continue;
        var r = await processSingleImage(files[fi], fi, promptContent, jobId);
        results[fi] = r;
        if (r.status !== "success") allSuccess = false;

        await axios.post(
          process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
          [{ id: jobId, results: results, updatedAt: Date.now() }],
          { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
        );
      }
    } else {
      for (var fi2 = 0; fi2 < files.length; fi2++) {
        if (results[fi2] && results[fi2].status === "success") continue;
        var r2 = await processSingleImage(files[fi2], fi2, promptContent, jobId);
        results[fi2] = r2;
        if (r2.status !== "success") allSuccess = false;

        await axios.post(
          process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
          [{ id: jobId, results: results, updatedAt: Date.now() }],
          { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
        );
      }
    }

    // 5. 更新最终状态
    if (allSuccess) {
      await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
        [{ id: jobId, status: "completed", results: results, updatedAt: Date.now() }],
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
      );
    } else {
      var retryCount = (job.retryCount || 0) + 1;
      var maxRetries = job.maxRetries || 2;
      if (retryCount >= maxRetries) {
        await axios.post(
          process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
          [{ id: jobId, status: "failed", retryCount: retryCount, results: results, updatedAt: Date.now() }],
          { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
        );
      } else {
        var nextRetryAt = Date.now() + 5 * 60 * 1000;
        await axios.post(
          process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
          [{ id: jobId, status: "failed", retryCount: retryCount, nextRetryAt: nextRetryAt, results: results, updatedAt: Date.now() }],
          { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
        );
      }
    }

    var successCount = results.filter(function (r) { return r && r.status === "success"; }).length;
    var failCount = results.filter(function (r) { return r && r.status === "failed"; }).length;

    return Response.json({
      success: true,
      message: "处理完成：" + successCount + " 成功，" + failCount + " 失败",
      jobId: jobId,
      results: results,
    });
  } catch (err) {
    console.error("队列处理失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
