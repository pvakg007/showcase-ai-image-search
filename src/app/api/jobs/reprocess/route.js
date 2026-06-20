export const dynamic = "force-dynamic";
import COS from "cos-nodejs-sdk-v5";
import axios from "axios";
import {
  tryParseJson, extractSearchFields, buildMarkdown, compressImage,
  streamAiResponse, readAiSettings, getDefaultPrompt,
} from "@/lib/pipeline";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

function extractKey(url) {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch (_) { return null; }
}

/**
 * POST /api/jobs/reprocess — 重新分析单张图片
 * Body: { id, url, mdUrl }
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

    // 读取 AI 设置 + 现有文档（拿 spaceNames/projectName 保留）
    var aiSettings = await readAiSettings(cos);
    var existingDoc = null;
    try {
      var docRes = await axios.get(
        process.env.MEILISEARCH_HOST + "/indexes/design_images/documents/" + id,
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY } }
      );
      existingDoc = docRes.data;
    } catch (_) {}
    var spaceNames = (existingDoc && Array.isArray(existingDoc.spaceNames)) ? existingDoc.spaceNames : [];
    var projectName = (existingDoc && existingDoc.projectName) || "";

    // 下载已有图片（images/ 下，已是浏览器压缩版）→ 透传测尺寸
    var imageKey = extractKey(url);
    if (!imageKey) {
      return Response.json({ success: false, error: "无法从 URL 解析 COS key" }, { status: 400 });
    }
    var data = await new Promise(function (resolve, reject) {
      cos.getObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: imageKey },
        function (err, d) { if (err) reject(err); else resolve(d); });
    });
    var buffer = Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body);
    var comp = await compressImage(buffer);
    var base64Image = comp.buffer.toString("base64");

    // 提示词：优先 admin 自定义 → 文件 → 内嵌默认
    var promptContent = "";
    if (aiSettings.aiPrompt && aiSettings.aiPrompt.trim()) {
      promptContent = aiSettings.aiPrompt;
    } else {
      try {
        var fs = require("fs"), path = require("path");
        promptContent = fs.readFileSync(path.join(process.cwd(), "提示词.txt"), "utf-8");
      } catch (_) { promptContent = getDefaultPrompt(); }
    }

    var bucketDomain = (process.env.COS_BUCKET || "") + ".cos." + (process.env.COS_REGION || "") + ".myqcloud.com";

    var baseUrl = aiSettings.aiUrl.replace(/\/+$/, "");
    var chatUrl = baseUrl.indexOf("/chat/completions") === -1 ? baseUrl + "/chat/completions" : baseUrl;

    var openaiBody = {
      model: aiSettings.aiModel, stream: true, max_tokens: 8192,
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
      "Authorization": "Bearer " + aiSettings.aiKey,
      "x-dashscope-api-key": aiSettings.aiKey,
    };

    console.log("[reprocess] 流式调用 AI:", chatUrl);
    var streamResult = await streamAiResponse(chatUrl, openaiBody, openaiHeaders, {});

    if (!streamResult || !streamResult.content) {
      var errMsg = (streamResult && streamResult.error) || "AI 分析未返回有效内容";
      console.error("[reprocess] AI 分析失败:", errMsg);
      return Response.json({ success: false, error: errMsg });
    }

    var analysisRaw = streamResult.content;
    var analysis = tryParseJson(analysisRaw);
    if (!analysis) {
      return Response.json({ success: false, error: "AI 返回内容解析失败（非 JSON 格式）" });
    }

    var searchFields = extractSearchFields(analysis, null, spaceNames);
    var timestamp = Date.now();

    // 覆盖 MD / JSON
    var existingMdKey = mdUrl ? extractKey(mdUrl) : null;
    var mdContent = buildMarkdown(analysis, url, timestamp, spaceNames, null);
    var finalMdKey = existingMdKey || "summaries/" + timestamp + "-reanalyzed.md";

    await new Promise(function (resolve, reject) {
      cos.putObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
        Key: finalMdKey, Body: Buffer.from(mdContent, "utf-8"),
        ContentType: "text/markdown; charset=utf-8", ACL: "public-read",
      }, function (err) { if (err) reject(err); else resolve(); });
    });
    var mdUrlFinal = "https://" + bucketDomain + "/" + finalMdKey;

    cos.putObject({
      Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
      Key: finalMdKey.replace(/\.md$/, ".json"), Body: Buffer.from(analysisRaw, "utf-8"),
      ContentType: "application/json; charset=utf-8", ACL: "public-read",
    }, function () {});

    // 更新 Meilisearch（保留 spaceNames/projectName）
    var document = {
      id: id, url: url, mdUrl: mdUrlFinal,
      title: searchFields.title, summary: searchFields.summary, tags: searchFields.tags,
      spaceNames: spaceNames, spaceName: spaceNames.join("、"), projectName: projectName,
      updatedAt: timestamp,
    };
    try {
      await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/design_images/documents", [document],
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.warn("[reprocess] Meilisearch 索引失败:", err.message);
    }

    return Response.json({
      success: true,
      data: { id: id, title: searchFields.title, summary: searchFields.summary, tags: searchFields.tags, mdUrl: mdUrlFinal },
    });
  } catch (err) {
    console.error("重新分析失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
