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

/** 恢复卡住的任务（processing 状态 > 2 分钟未心跳 → 视为 SSE 函数已死，重置为 pending） */
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
      // 重置为 pending，保留 aiRaw / files.compressedKey 等断点 → runPipeline 从断点续跑
      await updateJob(j.id, { status: "pending", processingLock: 0, updatedAt: Date.now() });
    }
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

    // 静默跑完整流水线（onEvent 空 → 无推送，靠断点续跑）
    var result = await runPipeline(job, { onEvent: function () {}, heartbeat: function () {} });

    await updateJob(jobId, {
      status: result.success ? "completed" : "failed",
      results: result.results,
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
