export const dynamic = "force-dynamic";
import COS from "cos-nodejs-sdk-v5";
import axios from "axios";
import path from "path";
import fs from "fs";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

// Sharp 动态导入
var sharp = null;
try { sharp = require("sharp"); } catch (_) {}

// ============================================================
// 辅助函数（与 process-queue 共享逻辑）
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

function extractKey(url) {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch (_) { return null; }
}

/**
 * POST /api/jobs/reprocess — 重新分析单张图片
 *
 * Body: { id, url, mdUrl }
 * 流程：
 *   1. 从 COS 下载已有压缩图片
 *   2. 用当前 AI 设置和提示词重新分析
 *   3. 覆盖 MD 文件、JSON 文件
 *   4. 更新 Meilisearch design_images 文档
 *   5. 返回新的 title/summary/tags/mdUrl
 */
export async function POST(req) {
  var auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    var decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
    var colon = decoded.indexOf(":");
    var user = decoded.slice(0, colon);
    var pass = decoded.slice(colon + 1);
    if (user !== process.env.ADMIN_USERNAME || pass !== process.env.ADMIN_PASSWORD) {
      return Response.json({ success: false, error: "未授权" }, { status: 401 });
    }
  } catch (_) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    var body = await req.json();
    var { id, url, mdUrl } = body || {};
    if (!id || !url) {
      return Response.json({ success: false, error: "缺少 id 或 url" }, { status: 400 });
    }

    // 1. 读取 AI 设置
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

    // 2. 从 URL 提取 COS key，下载图片
    var imageKey = extractKey(url);
    if (!imageKey) {
      return Response.json({ success: false, error: "无法从 URL 解析 COS key" }, { status: 400 });
    }

    var data = await new Promise(function (resolve, reject) {
      cos.getObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: imageKey,
      }, function (err, d) { if (err) reject(err); else resolve(d); });
    });
    var buffer = Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body);

    // 3. 压缩（确保统一质量）
    var compressed = await compressImage(buffer, 1600);
    var base64Image = compressed.toString("base64");

    // 4. 读取提示词
    var promptContent = "";
    if (aiPrompt && aiPrompt.trim()) {
      promptContent = aiPrompt;
    } else {
      try {
        promptContent = fs.readFileSync(path.join(process.cwd(), "提示词.txt"), "utf-8");
      } catch (_) {
        promptContent = "你是资深软装设计专家，请对图片进行深度软装分析。输出JSON格式。";
      }
    }

    var bucketDomain = (process.env.COS_BUCKET || "") + ".cos." + (process.env.COS_REGION || "") + ".myqcloud.com";

    // 5. 调用 AI
    var FALLBACK_URLS = [
      aiUrl,
      "https://llm-28jx4qmqak31ymc9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      "https://ws-zwf60r4eps2lu9v2.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ].filter(function (u) { return u && u.length > 0; });

    var openaiBody = {
      model: aiModel, max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: promptContent },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64Image } },
        ],
      }],
    };

    var openaiHeaders = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + aiKey,
      "x-dashscope-api-key": aiKey,
    };

    var analysisRaw = "";
    var analysis = null;
    var lastErrMsg = "";

    for (var u = 0; u < FALLBACK_URLS.length && !analysisRaw; u++) {
      var baseUrl = FALLBACK_URLS[u].replace(/\/+$/, "");
      var chatUrl = baseUrl.indexOf("/chat/completions") === -1
        ? baseUrl + "/chat/completions" : baseUrl;

      try {
        console.log("[reprocess] AI 尝试 URL" + (u + 1) + ": " + chatUrl);
        var resp = await axios.post(chatUrl, openaiBody, {
          headers: openaiHeaders, timeout: 30000,
        });
        if (resp && resp.status < 500) {
          var rd = resp.data;
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
            lastErrMsg = "[URL" + (u + 1) + "] 响应格式无法识别";
          }
        }
      } catch (err) {
        var statusCode = err.response?.status || 0;
        var msg = err.response?.data?.error?.message || err.response?.data?.message || err.message || "未知错误";
        lastErrMsg = "[URL" + (u + 1) + "] " + msg;
        if (statusCode === 401 || statusCode === 403) break;
      }
    }

    if (analysisRaw) {
      analysis = tryParseJson(analysisRaw);
      if (!analysis) {
        console.warn("[reprocess] AI 返回非 JSON:", analysisRaw.substring(0, 200));
      }
    }

    var searchFields;
    if (!analysis && lastErrMsg) {
      searchFields = { title: "AI 分析失败", summary: "错误: " + lastErrMsg.substring(0, 300), tags: [] };
    } else {
      searchFields = extractSearchFields(analysis);
    }
    var timestamp = Date.now();

    // 6. 覆盖 MD 文件
    var existingMdKey = mdUrl ? extractKey(mdUrl) : null;
    var mdContent = buildMarkdown(analysis, url, timestamp, []);
    var finalMdKey = existingMdKey || "summaries/" + timestamp + "-reanalyzed.md";

    await new Promise(function (resolve, reject) {
      cos.putObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
        Key: finalMdKey, Body: Buffer.from(mdContent, "utf-8"),
        ContentType: "text/markdown; charset=utf-8", ACL: "public-read",
      }, function (err) { if (err) reject(err); else resolve(); });
    });
    var mdUrlFinal = "https://" + bucketDomain + "/" + finalMdKey;

    // 7. 保存原始分析 JSON
    if (analysisRaw) {
      var rawFilename = finalMdKey.replace(/\.md$/, ".json");
      cos.putObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
        Key: rawFilename, Body: Buffer.from(analysisRaw, "utf-8"),
        ContentType: "application/json; charset=utf-8", ACL: "public-read",
      }, function () {});
    }

    // 8. 更新 Meilisearch 文档
    var document = {
      id: id,
      url: url,
      mdUrl: mdUrlFinal,
      title: searchFields.title,
      summary: searchFields.summary,
      tags: searchFields.tags,
      updatedAt: timestamp,
    };

    try {
      await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/design_images/documents",
        [document],
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.warn("[reprocess] Meilisearch 索引失败:", err.message);
    }

    return Response.json({
      success: true,
      data: {
        id: id,
        title: searchFields.title,
        summary: searchFields.summary,
        tags: searchFields.tags,
        mdUrl: mdUrlFinal,
      },
    });
  } catch (err) {
    console.error("重新分析失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
