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
  var title = "未命名图片", summary = "暂无总结", tags = ["设计图"];
  try {
    var sd = analysis?.styleDefinition;
    var oes = analysis?.overallEmotionalStyle;
    if (sd?.coreStyle) title = sd.coreStyle + " 设计分析";
    var parts = [];
    if (oes?.coreTemperament) parts.push("核心气质：" + oes.coreTemperament);
    if (Array.isArray(oes?.detailedInterpretation)) parts.push.apply(parts, oes.detailedInterpretation);
    if (parts.length > 0) summary = parts.join("；");
    var tagSet = new Set(["设计图"]);
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
    return buffer; // 返回原始数据，不阻塞流程
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

    // 上传压缩后的图片（public-read）
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

    // 删除临时文件
    cos.deleteObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: cosKey,
    }, function () {});

    var imageUrl = "https://" + compressedKey;
    // 对于 COS，需要加上 bucket 域名前缀
    // 实际格式：https://<bucket>.cos.<region>.myqcloud.com/<key>
    // 但 SDK 的 Location 返回的是完整路径，这里手动拼接
    var bucketDomain = (process.env.COS_BUCKET || "") + ".cos." + (process.env.COS_REGION || "") + ".myqcloud.com";
    imageUrl = "https://" + bucketDomain + "/" + compressedKey;

    // 3. 构建提示词
    var spaceLabel = Array.isArray(fileInfo.spaceNames) && fileInfo.spaceNames.length > 0
      ? fileInfo.spaceNames.join("、") : "未命名空间";

    var promptForImage = "图 " + (index + 1) + "：" + spaceLabel + "\n\n" + promptContent;

    // 4. 调用 Spark API
    console.log("[process] AI 分析:", compressedKey);
    var base64Image = compressed.toString("base64");
    var analysisRaw = "";
    var analysis = null;

    // 先尝试从 COS 读取 AI 设置（服务商地址 + 模型名），再回退到环境变量
    var aiUrl = process.env.SPARK_API_URL || "https://dashscope.aliyuncs.com/apps/anthropic";
    var aiModel = process.env.SPARK_MODEL || "qwen3.6-plus";
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
    } catch (_) { /* 无配置文件，使用环境变量默认值 */ }

    var apiBase = aiUrl.replace(/\/+$/, "");
    var urlsToTry = [apiBase + "/v1/messages", apiBase];
    var sparkRes = null;

    for (var u = 0; u < urlsToTry.length; u++) {
      try {
        sparkRes = await axios.post(urlsToTry[u], {
          model: aiModel,
          max_tokens: 4096,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: promptForImage },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
            ],
          }],
        }, {
          headers: { "x-api-key": process.env.SPARK_API_KEY || "", "Content-Type": "application/json" },
          timeout: 60000,
        });
        if (sparkRes && sparkRes.status < 500) break;
      } catch (err) {
        if (err.response && err.response.status < 500) break;
      }
    }

    if (sparkRes && sparkRes.data && sparkRes.data.content && sparkRes.data.content[0]) {
      analysisRaw = sparkRes.data.content[0].text || "";
      analysis = tryParseJson(analysisRaw);
    }

    var searchFields = extractSearchFields(analysis);
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
      // 检查是否有待重试的任务
      var retryRes = await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
        { q: "", filter: 'status = "failed" AND retryCount < maxRetries', limit: 1, sort: ["nextRetryAt:asc"] },
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
      );
      hits = retryRes.data.hits || [];
      if (hits.length > 0) {
        var now = Date.now();
        // 只取已到重试时间的
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
    var results = (job.results || []).slice(); // 保留已有结果
    var allSuccess = true;

    // 4. 处理图片
    if (job.type === "batch") {
      // 批量模式：所有图片放到一个 prompt（但 Spark API 可能不支持多图，所以退化为逐张）
      // 实际上用逐张处理更可靠
      for (var fi = 0; fi < files.length; fi++) {
        // 跳过已成功处理的
        if (results[fi] && results[fi].status === "success") continue;
        var r = await processSingleImage(files[fi], fi, promptContent, jobId);
        results[fi] = r;
        if (r.status !== "success") allSuccess = false;

        // 更新进度
        await axios.post(
          process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
          [{ id: jobId, results: results, updatedAt: Date.now() }],
          { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
        );
      }
    } else {
      // 逐张模式：每张图单独分析
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
        // 5分钟后重试
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
