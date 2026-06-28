export const dynamic = "force-dynamic";
import axios from "axios";
import { runPipeline } from "@/lib/pipeline";

// 后台工作进程：恢复卡住任务 + 静默处理 pending 任务（无 SSE，用于断点续跑/重试）。
// 在页面加载时 fire-and-forget 触发（main/admin/upload 页面），实现"关页面后下次访问续跑"。
// 支持 ?jobId=xxx 直接处理指定任务（分批续跑用，避开 Meilisearch 写后索引延迟）。
export const maxDuration = 290;

var MEILI = function () { return process.env.MEILISEARCH_HOST; };
var KEY = function () { return process.env.MEILISEARCH_API_KEY; };
var H = function () { return { Authorization: "Bearer " + KEY(), "Content-Type": "application/json" }; };

async function searchJobs(params) {
  var res = await axios.post(MEILI() + "/indexes/processing_jobs/search", params, { headers: H() });
  return res.data.hits || [];
}

async function updateJob(jobId, fields) {
  await axios.post(MEILI() + "/indexes/processing_jobs/documents",
    [Object.assign({ id: jobId }, fields)], { headers: H() });
}

/** 按 id 直接取任务文档（避开搜索的索引延迟） */
async function getJobById(jobId) {
  try {
    var r = await axios.get(MEILI() + "/indexes/processing_jobs/documents/" + encodeURIComponent(jobId), { headers: { Authorization: "Bearer " + KEY() } });
    return r.data || null;
  } catch (_) { return null; }
}

/**
 * 恢复卡住的任务（processing 状态 > 90s 未心跳 → 视为函数已死，重置为 pending）。
 * 返回刚被重置的任务数组，供本次调用直接处理（避开"写后立即搜索"的索引延迟）。
 */
async function recoverStuckJobs() {
  var reset = [];
  try {
    var cutoff = Date.now() - 90 * 1000;
    var stuckHits = await searchJobs({
      q: "",
      filter: 'status = "processing" AND processingLock < ' + cutoff,
      limit: 10,
      sort: ["createdAt:asc"],
    });
    for (var j of stuckHits) {
      console.log("[recovery] 恢复卡住的任务:", j.id);
      var log = Array.isArray(j.progressLog) ? j.progressLog.slice() : [];
      log.push({ ts: Date.now(), event: "recovered", msg: "卡住" + Math.round((Date.now() - (j.processingLock || cutoff)) / 1000) + "s 后被恢复机制捡起" });
      if (log.length > 30) log = log.slice(-30);
      await updateJob(j.id, { status: "pending", processingLock: 0, progressLog: log, updatedAt: Date.now() });
      j.status = "pending";
      reset.push(j);
    }
  } catch (_) {}
  return reset;
}

/** 触发下一次后台处理（fire-and-forget，带 jobId 直达，避开索引延迟） */
function triggerNext(jobId) {
  try {
    var baseUrl = process.env.VERCEL_URL
      ? "https://" + process.env.VERCEL_URL
      : (process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000");
    var url = baseUrl + "/api/process-queue";
    if (jobId) url += "?jobId=" + encodeURIComponent(jobId);
    fetch(url, { method: "GET", headers: { "x-api-key": "internal" } }).catch(function () {});
  } catch (_) {}
}

export async function GET(req) {
  try {
    var targetJobId = req && req.nextUrl ? req.nextUrl.searchParams.get("jobId") : null;
    var recovered = await recoverStuckJobs();

    // 选任务：优先 ?jobId 直达 → 否则搜 pending → 否则用刚恢复的（避开索引延迟）
    var job = null;
    if (targetJobId) {
      job = await getJobById(targetJobId);
      if (job && job.status !== "pending") job = null; // 非 pending 不处理（可能正被 SSE 处理）
    }
    if (!job) {
      var hits = await searchJobs({ q: "", filter: 'status = "pending"', limit: 1, sort: ["createdAt:asc"] });
      job = hits[0];
    }
    if (!job && recovered.length > 0) {
      job = recovered[0];
    }
    if (!job) {
      return Response.json({ success: true, message: "暂无可处理的任务" });
    }

    var jobId = job.id;
    console.log("[queue] 取到任务", jobId, "status=", job.status, "files=", (job.files ? job.files.length : "无"),
      "batches=", (job.batches ? job.batches.length : "无"), "results=", (job.results ? job.results.length : "无"));
    if (!job.files || job.files.length === 0) {
      // files 丢失（历史数据或并发踩踏）—— 不要清空已有 results，标记失败并保留诊断信息
      console.error("[queue] 任务 files 为空，无法续跑:", jobId, JSON.stringify({ batches: job.batches, results: job.results }));
      await updateJob(jobId, { status: "failed", error: "任务文件列表为空（files 字段丢失，可能需重新上传）", updatedAt: Date.now() });
      return Response.json({ success: false, error: "任务文件列表为空" });
    }

    // 锁定
    await updateJob(jobId, { status: "processing", processingLock: Date.now(), aiPhase: "running", updatedAt: Date.now() });

    // heartbeat：节流刷新 processingLock（每 ~20s 一次），防止 AI 长等待时被 recoverStuckJobs 误重置
    var lastLock = Date.now();
    function bgHeartbeat() {
      var now = Date.now();
      if (now - lastLock < 18000) return;
      lastLock = now;
      try { updateJob(jobId, { processingLock: now, updatedAt: now }); } catch (_) {}
    }

    // 静默跑流水线（onEvent 空 → 无推送，靠 batches 断点续跑）
    var result = await runPipeline(job, { onEvent: function () {}, heartbeat: bgHeartbeat });

    if (result.stopped) {
      // 时间预算中止：仍有 pending 批 → 置 pending 并立即触发下一轮接力续跑（不标记 failed）
      await updateJob(jobId, { status: "pending", processingLock: 0, results: result.results, batches: result.batches, aiPhase: "paused", updatedAt: Date.now() });
      triggerNext(jobId);
      return Response.json({ success: true, message: "时间预算中止，已触发后台续跑", jobId: jobId });
    }

    // 全部批次跑完（可能有失败的批）
    var allDone = (result.batches || []).every(function (b) { return b && b.status !== "pending" && b.status !== "processing"; });
    var anyFailed = (result.batches || []).some(function (b) { return b && b.status === "failed"; });
    var success = allDone && !anyFailed;
    await updateJob(jobId, {
      status: success ? "completed" : "failed",
      results: result.results,
      batches: result.batches,
      error: success ? null : (anyFailed ? "部分批次失败" : (result.error || "处理失败")),
      processingLock: 0,
      aiPhase: success ? "done" : "failed",
      updatedAt: Date.now(),
    });

    return Response.json({
      success: success,
      message: success ? "处理完成" : "部分批次失败",
      jobId: jobId,
      results: result.results,
    });
  } catch (err) {
    console.error("队列处理失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
