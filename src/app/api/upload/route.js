import COS from "cos-nodejs-sdk-v5";
import axios from "axios";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

/**
 * POST /api/upload — 异步上传
 *
 * 流程：
 *   1. 接收文件 → 保存到 COS（temp/ 前缀）
 *   2. 创建处理任务记录到 Meilisearch（processing_jobs 索引）
 *   3. 立即返回 jobId
 *   4. 尝试触发后台队列处理
 *
 * FormData:
 *   - files[] — 图片文件
 *   - spaceNames[] — 每张图的空间名称（JSON 数组字符串）
 *   - projectName — 项目名称（可选）
 *   - mode — "batch" 或 "individual"（可选，默认 individual）
 */
export async function POST(req) {
  try {
    var formData = await req.formData();
    var mode = formData.get("mode") || "individual";
    var projectName = formData.get("projectName") || "";

    // 获取文件列表
    var files = formData.getAll("files");
    if (!files || files.length === 0) {
      var singleFile = formData.get("file");
      if (singleFile) files = [singleFile];
    }
    if (!files || files.length === 0) {
      return Response.json({ success: false, error: "未选择文件" }, { status: 400 });
    }

    // 获取空间名称
    var rawSpaceNames = formData.getAll("spaceNames") || [];
    if (rawSpaceNames.length === 0 && formData.get("spaceName")) {
      rawSpaceNames = [formData.get("spaceName")];
    }

    var jobId = Date.now().toString();
    var jobFiles = [];

    // 1. 上传所有文件到 COS（temp/ 前缀，无需 public-read）
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file || typeof file === "string") continue;

      var arrayBuffer = await file.arrayBuffer();
      var buffer = Buffer.from(arrayBuffer);
      var ts = Date.now() + i;
      // 保持原始文件名，存到 temp/ 下
      var cosKey = "temp/" + ts + "-" + file.name;

      await new Promise(function (resolve, reject) {
        cos.putObject({
          Bucket: process.env.COS_BUCKET,
          Region: process.env.COS_REGION,
          Key: cosKey,
          Body: buffer,
        }, function (err) { if (err) reject(err); else resolve(); });
      });

      // 解析空间名称
      var raw = rawSpaceNames[i] || "";
      var parsedNames = [];
      try { parsedNames = JSON.parse(raw); if (!Array.isArray(parsedNames)) parsedNames = [raw]; }
      catch (_) { parsedNames = raw ? [raw] : []; }
      parsedNames = parsedNames.filter(Boolean);

      jobFiles.push({
        cosKey: cosKey,
        originalName: file.name,
        mimeType: file.type || "image/jpeg",
        size: buffer.length,
        spaceNames: parsedNames,
      });
    }

    // 2. 创建处理任务记录
    var jobDoc = {
      id: jobId,
      type: mode === "batch" ? "batch" : "individual",
      status: "pending",
      projectName: projectName,
      files: jobFiles,
      results: [],
      retryCount: 0,
      maxRetries: 2,
      nextRetryAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    try {
      await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
        [jobDoc],
        {
          headers: {
            Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      console.error("创建任务记录失败:", err.message);
    }

    // 3. 配置 Meilisearch 索引（幂等）
    try {
      axios.patch(
        process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/settings",
        {
          searchableAttributes: ["id"],
          filterableAttributes: ["status", "retryCount", "maxRetries"],
          sortableAttributes: ["createdAt"],
        },
        {
          headers: {
            Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
            "Content-Type": "application/json",
          },
        }
      ).catch(function () {});
    } catch (_) {}

    // 保存项目名称到 localStorage（通过响应返回，客户端自行保存）
    // 4. 触发后台处理（fire-and-forget，Vercel 会在响应后短暂保持运行）
    try {
      var baseUrl = process.env.VERCEL_URL
        ? "https://" + process.env.VERCEL_URL
        : (process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000");
      // 使用 undici/fetch 的 keepalive 来触发后台处理
      fetch(baseUrl + "/api/process-queue", {
        method: "GET",
        headers: { "x-api-key": "internal" },
      }).catch(function () {});
    } catch (_) {}

    return Response.json({
      success: true,
      message: "文件已上传，已加入处理队列",
      jobId: jobId,
      mode: mode,
      fileCount: jobFiles.length,
    });
  } catch (error) {
    console.error("上传错误:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
