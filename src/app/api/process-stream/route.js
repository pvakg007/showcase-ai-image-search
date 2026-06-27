export const dynamic = "force-dynamic";
import axios from "axios";
import { runPipeline } from "@/lib/pipeline";

// SSE 流式端点最长运行时间（Vercel Pro 上限 300，留 10s 余量）
export const maxDuration = 290;

var MEILI = function () { return process.env.MEILISEARCH_HOST; };
var MEILI_KEY = function () { return process.env.MEILISEARCH_API_KEY; };
var H = function () { return { Authorization: "Bearer " + MEILI_KEY(), "Content-Type": "application/json" }; };

var encoder = new TextEncoder();

/** 一次性 SSE 响应（用于 setup 失败 / 任务已结束等场景） */
function sseOnce(events) {
  var stream = new ReadableStream({
    start(controller) {
      events.forEach(function (ev) {
        try { controller.enqueue(encoder.encode("event: " + ev.type + "\ndata: " + JSON.stringify(ev.data || {}) + "\n\n")); } catch (_) {}
      });
      try { controller.close(); } catch (_) {}
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
  });
}

/**
 * GET /api/process-stream?jobId=xxx
 * SSE 实时推送整个流水线。任何错误都转成 fatal 事件，绝不返回裸 500。
 */
export async function GET(req) {
  var jobId;
  try {
    jobId = req.nextUrl.searchParams.get("jobId");
  } catch (e) {
    return sseOnce([{ type: "fatal", data: { stage: "setup", message: "无法读取 jobId: " + (e && e.message) } }]);
  }
  if (!jobId) {
    return sseOnce([{ type: "fatal", data: { stage: "setup", message: "缺少 jobId" } }]);
  }

  // 查找任务：直接按主键取文档（避免 filter id 需要 id 为 filterable 的依赖）
  var job = null;
  try {
    var res = await axios.get(
      MEILI() + "/indexes/processing_jobs/documents/" + encodeURIComponent(jobId),
      { headers: H() }
    );
    job = res.data;
  } catch (err) {
    console.error("[stream] 查询任务失败:", err.message);
    return sseOnce([{ type: "fatal", data: { stage: "setup", message: "查询任务失败: " + err.message } }]);
  }

  if (!job || !job.id) {
    return sseOnce([{ type: "fatal", data: { stage: "setup", message: "任务不存在: " + jobId } }]);
  }

  // 任务已结束 → 推终态事件
  if (job.status === "completed" || job.status === "failed") {
    return sseOnce([{ type: job.status === "completed" ? "complete" : "fatal", data: { results: job.results || [], message: job.error || "" } }]);
  }

  // 锁定任务
  try {
    await axios.post(
      MEILI() + "/indexes/processing_jobs/documents",
      [{ id: jobId, status: "processing", processingLock: Date.now(), aiPhase: "starting", updatedAt: Date.now() }],
      { headers: H() }
    );
  } catch (err) {
    console.error("[stream] 锁定任务失败:", err.message);
    return sseOnce([{ type: "fatal", data: { stage: "setup", message: "锁定任务失败: " + err.message } }]);
  }

  var lastLockUpdate = Date.now();
  async function heartbeat() {
    var now = Date.now();
    if (now - lastLockUpdate < 25000) return;
    lastLockUpdate = now;
    try {
      await axios.post(MEILI() + "/indexes/processing_jobs/documents",
        [{ id: jobId, processingLock: now, updatedAt: now }], { headers: H() });
    } catch (_) {}
  }

  var clientAlive = true;

  var stream = new ReadableStream({
    async start(controller) {
      function send(type, data) {
        if (!clientAlive) return;
        try {
          controller.enqueue(encoder.encode("event: " + type + "\ndata: " + JSON.stringify(data || {}) + "\n\n"));
        } catch (_) {
          clientAlive = false;
        }
      }

      send("start", { jobId: jobId, total: (job.files || []).length });

      try {
        var result = await runPipeline(job, {
          onEvent: function (type, data) { send(type === "error" ? "fatal" : type, data); },
          heartbeat: heartbeat,
        });

        if (result.stopped) {
          // 时间预算中止：仍有 pending 批 → 置 pending 触发后台续跑，告知前端转入后台
          try {
            await axios.post(MEILI() + "/indexes/processing_jobs/documents",
              [{ id: jobId, status: "pending", processingLock: 0, results: result.results, batches: result.batches, aiPhase: "paused", updatedAt: Date.now() }],
              { headers: H() });
          } catch (_) {}
          // fire-and-forget 触发后台接力
          try {
            var base = process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : (process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000");
            fetch(base + "/api/process-queue", { method: "GET", headers: { "x-api-key": "internal" } }).catch(function () {});
          } catch (_) {}
          send("paused", { message: "本段时间预算用完，剩余批次已转入后台继续", results: result.results });
        } else {
          await updateJobStatus(jobId, result.success ? "completed" : "failed", result.results, result.error);
          if (result.success) {
            send("complete", { results: result.results });
          } else {
            send("fatal", { stage: "final", message: result.error || "处理失败", results: result.results });
          }
        }
      } catch (err) {
        console.error("[stream] 流水线异常:", err && err.stack || err && err.message || err);
        try { await updateJobStatus(jobId, "failed", [], (err && err.message) || "异常"); } catch (_) {}
        send("fatal", { stage: "exception", message: (err && err.message) || "处理异常" });
      } finally {
        try { controller.close(); } catch (_) {}
      }
    },
    cancel() {
      clientAlive = false;
      console.log("[stream] 客户端断开，流水线转入后台继续");
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
  });
}

async function updateJobStatus(jobId, status, results, error) {
  await axios.post(
    MEILI() + "/indexes/processing_jobs/documents",
    [{ id: jobId, status: status, results: results || [], error: error || null, processingLock: 0, aiPhase: status, updatedAt: Date.now() }],
    { headers: H() }
  );
}
