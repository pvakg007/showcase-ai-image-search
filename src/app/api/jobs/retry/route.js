export const dynamic = "force-dynamic";
import axios from "axios";

/**
 * POST /api/jobs/retry — 重试失败任务（管理员）
 *
 * Body: { jobId: string }
 * 将失败任务重置为 pending 状态，清空失败记录，触发后台处理。
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
    var { jobId } = await req.json();
    if (!jobId) {
      return Response.json({ success: false, error: "缺少 jobId" }, { status: 400 });
    }

    // 验证任务存在且处于可重试状态
    var res = await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
      { q: jobId, attributesToSearchOn: ["id"], limit: 1 },
      { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY } }
    );

    var hits = res.data.hits || [];
    if (hits.length === 0) {
      return Response.json({ success: false, error: "任务不存在" }, { status: 404 });
    }

    var job = hits[0];
    if (job.status !== "failed") {
      return Response.json({ success: false, error: "只有失败状态的任务可以重试" }, { status: 400 });
    }

    // 重置失败的结果槽，保留成功的
    var resetResults = (job.results || []).map(function (r) {
      if (r && r.status === "failed") return null;
      return r;
    });

    // 重置 failed 批为 pending（done 批保留，续跑时跳过）
    var resetBatches = (job.batches || []).map(function (b) {
      if (!b) return b;
      if (b.status === "failed") return Object.assign({}, b, { status: "pending", error: "" });
      return b;
    });

    // 追加 progressLog
    var log = Array.isArray(job.progressLog) ? job.progressLog.slice() : [];
    log.push({ ts: Date.now(), event: "manual_retry", msg: "管理员手动重试，重置失败批次，重试次数清零（使用最新模型/网址 + 原有提示词）" });
    if (log.length > 30) log = log.slice(-30);

    await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
      [{
        id: jobId,
        status: "pending",
        retryCount: 0,
        nextRetryAt: 0,
        processingLock: 0,
        results: resetResults,
        batches: resetBatches,
        progressLog: log,
        updatedAt: Date.now(),
      }],
      { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
    );

    // 触发后台处理
    try {
      var baseUrl = process.env.VERCEL_URL
        ? "https://" + process.env.VERCEL_URL
        : (process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000");
      fetch(baseUrl + "/api/process-queue", {
        method: "GET",
        headers: { "x-api-key": "internal" },
      }).catch(function () {});
    } catch (_) {}

    return Response.json({ success: true, message: "任务已重置为待处理" });
  } catch (err) {
    console.error("重试任务失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
