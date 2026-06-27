export const dynamic = "force-dynamic";
import axios from "axios";
import { runPipeline } from "@/lib/pipeline";

// 后台工作进程：恢复卡住任务 + 静默处理 pending 任务（无 SSE，用于断点续跑/重试）。
// 在页面加载时 fire-and-forget 触发（main/admin/upload 页面），实现"关页面后下次访问续跑"。
export const maxDuration = 290;

async function searchJobs(params) {
  var res = await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search", params,
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );
  return res.data.hits || [];
}

async function updateJob(jobId, fields) {
  await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
    [Object.assign({ id: jobId }, fields)],
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );
}

/** 恢复卡住的任务（processing 状态 > 2 分钟未心跳 → 视为函数已死，重置为 pending） */
async function recoverStuckJobs() {
  try {
    var cutoff = Date.now() - 2 * 60 * 1000;
    var stuckHits = await searchJobs({
      q: "",
      filter: 'status = "processing" AND processingLock < ' + cutoff,
      limit: 10,
      sort: ["createdAt:asc"],
    });
    for (var j of stuckHits) {
      console.log("[recovery] 恢复卡住的任务:", j.id);
      // 重置为 pending，保留 files.compressedKey / batches 等断点 → runPipeline 从断点续跑
      // 追加 progressLog 一条，向后台汇报恢复事件
      var log = Array.isArray(j.progressLog) ? j.progressLog.slice() : [];
      log.push({ ts: Date.now(), event: "recovered", msg: "卡住" + Math.round((Date.now() - (j.processingLock || cutoff)) / 1000) + "s 后被恢复机制捡起" });
      if (log.length > 30) log = log.slice(-30);
      await updateJob(j.id, { status: "pending", processingLock: 0, progressLog: log, updatedAt: Date.now() });
    }
  } catch (_) {}
}

/** 触发本服务下一次后台处理（fire-and-forget，用于分批续跑） */
function triggerNext() {
  try {
    var baseUrl = process.env.VERCEL_URL
      ? "https://" + process.env.VERCEL_URL
      : (process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000");
    fetch(baseUrl + "/api/process-queue", { method: "GET", headers: { "x-api-key": "internal" } }).catch(function () {});
  } catch (_) {}
}

export async function GET() {
  try {
    await recoverStuckJobs();

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
    if (!job.files || job.files.length === 0) {
      await updateJob(jobId, { status: "failed", results: [], error: "任务文件列表为空", updatedAt: Date.now() });
      return Response.json({ success: false, error: "任务文件列表为空" });
    }

    // 锁定
    await updateJob(jobId, { status: "processing", processingLock: Date.now(), aiPhase: "running", updatedAt: Date.now() });

    // 静默跑流水线（onEvent 空 → 无推送，靠 batches 断点续跑）
    var result = await runPipeline(job, { onEvent: function () {}, heartbeat: function () {} });

    if (result.stopped) {
      // 时间预算中止：仍有 pending 批 → 置 pending 并立即触发下一轮接力续跑（不标记 failed）
      await updateJob(jobId, { status: "pending", processingLock: 0, results: result.results, batches: result.batches, aiPhase: "paused", updatedAt: Date.now() });
      triggerNext();
      return Response.json({ success: true, message: "时间预算中止，已触发后台续跑", jobId: jobId });
    }

    await updateJob(jobId, {
      status: result.success ? "completed" : "failed",
      results: result.results,
      batches: result.batches,
      error: result.success ? null : result.error,
      processingLock: 0,
      aiPhase: result.success ? "done" : "failed",
      updatedAt: Date.now(),
    });

    return Response.json({
      success: result.success,
      message: result.success ? "处理完成" : (result.error || "部分失败"),
      jobId: jobId,
      results: result.results,
    });
  } catch (err) {
    console.error("队列处理失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
