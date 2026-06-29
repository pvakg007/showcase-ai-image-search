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
      await updateJob(j.id, { status: "pending", processingLock: 0, nextRetryAt: 0, progressLog: log, updatedAt: Date.now() });
      j.status = "pending";
      j.nextRetryAt = 0;
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

// ============================================================
// 10 天保留期清理：失败任务保留 10 天内可随时重试，超期自动清理
// 仅删 processing_jobs 任务记录，不影响 design_images 已生成的图片成品。
// ============================================================
var lastCleanupAt = 0;
var CLEANUP_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 天

async function cleanupOldJobs() {
  try {
    var cutoff = Date.now() - CLEANUP_RETENTION_MS;
    var oldJobs = await searchJobs({
      q: "",
      filter: 'status = "failed" AND createdAt < ' + cutoff,
      limit: 50,
      sort: ["createdAt:asc"],
    });
    for (var j of oldJobs) {
      try {
        await axios.delete(
          MEILI() + "/indexes/processing_jobs/documents/" + encodeURIComponent(j.id),
          { headers: { Authorization: "Bearer " + KEY() } }
        );
        console.log("[cleanup] 删除 10 天前的失败任务:", j.id, "createdAt=", j.createdAt);
      } catch (_) {}
    }
    if (oldJobs.length > 0) console.log("[cleanup] 共清理", oldJobs.length, "个过期失败任务");
  } catch (err) {
    console.warn("[cleanup] 清理失败任务异常:", err.message);
  }
}

/** 节流：最多每小时跑一次清理（nudge 频繁触发时避免重复查询；cron 每天 0 点必跑一次） */
async function maybeCleanup() {
  var now = Date.now();
  if (now - lastCleanupAt < 3600000) return;
  lastCleanupAt = now;
  await cleanupOldJobs();
}

export async function GET(req) {
  try {
    var targetJobId = req && req.nextUrl ? req.nextUrl.searchParams.get("jobId") : null;
    // 清理 10 天前的失败任务（节流，最多每小时一次）。失败任务在保留期内可随时重试，超期自动清理。
    await maybeCleanup();
    var recovered = await recoverStuckJobs();

    // 选任务：优先 ?jobId 直达 → 否则搜 pending → 否则用刚恢复的（避开索引延迟）
    var nowMs = Date.now();
    var job = null;
    if (targetJobId) {
      job = await getJobById(targetJobId);
      // 只处理 pending 且退避已到期的（非 pending 或还在退避中都不处理）
      if (job && (job.status !== "pending" || (job.nextRetryAt && job.nextRetryAt > nowMs))) job = null;
    }
    if (!job) {
      // 取 pending 任务（不在 SQL filter 里卡 nextRetryAt，否则缺失该字段的旧任务会被 Meilisearch 永久排除），
      // 在代码里挑第一个退避已到期的（nextRetryAt 缺失/0/<=now 立即可处理）。
      var hits = await searchJobs({ q: "", filter: 'status = "pending"', limit: 10, sort: ["createdAt:asc"] });
      for (var hi = 0; hi < hits.length; hi++) {
        if (!hits[hi].nextRetryAt || hits[hi].nextRetryAt <= nowMs) { job = hits[hi]; break; }
      }
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

    if (success) {
      await updateJob(jobId, {
        status: "completed", results: result.results, batches: result.batches,
        error: null, processingLock: 0, aiPhase: "done", updatedAt: Date.now(),
      });
      return Response.json({ success: true, message: "处理完成", jobId: jobId, results: result.results });
    }

    // 有批失败 → 自动重试（重试次数未超上限）
    var retryCount = (job.retryCount || 0) + 1;
    var maxRetries = job.maxRetries != null ? job.maxRetries : 2;
    if (retryCount <= maxRetries) {
      // 重置 failed 批为 pending（done 批保留）；下次 runPipeline 只重跑失败批
      var retryBatches = (result.batches || []).map(function (b) {
        if (b && b.status === "failed") return Object.assign({}, b, { status: "pending", error: "" });
        return b;
      });
      var backoffSec = retryCount * 60; // 第1次重试等60s，第2次等120s（给大模型 API 缓冲）
      var log = Array.isArray(job.progressLog) ? job.progressLog.slice() : [];
      log.push({ ts: Date.now(), event: "auto_retry", msg: "第" + retryCount + "/" + maxRetries + "次自动重试（" + backoffSec + "s 后），重置失败批次" });
      if (log.length > 30) log = log.slice(-30);
      await updateJob(jobId, {
        status: "pending", processingLock: 0, results: result.results, batches: retryBatches,
        retryCount: retryCount, nextRetryAt: Date.now() + backoffSec * 1000,
        progressLog: log, aiPhase: "retrying", error: "部分批次失败，自动重试中", updatedAt: Date.now(),
      });
      console.log("[queue] 任务", jobId, "第", retryCount, "次自动重试已排定，", backoffSec, "s 后执行");
      return Response.json({ success: false, message: "部分批次失败，已排定自动重试 #" + retryCount, jobId: jobId });
    }

    // 自动重试耗尽 → 标记 failed，等用户后台手动重试
    await updateJob(jobId, {
      status: "failed", results: result.results, batches: result.batches,
      error: anyFailed ? "部分批次失败（自动重试已耗尽，请手动重试）" : (result.error || "处理失败"),
      processingLock: 0, aiPhase: "failed", updatedAt: Date.now(),
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
