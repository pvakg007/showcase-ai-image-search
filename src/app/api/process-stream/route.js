export const dynamic = "force-dynamic";
import axios from "axios";
import { runPipeline } from "@/lib/pipeline";

// SSE 流式端点最长运行时间（Vercel Pro 上限 300，留 10s 余量）
export const maxDuration = 290;

/**
 * GET /api/process-stream?jobId=xxx
 *
 * SSE 实时推送整个处理流水线。客户端断开后：
 *   - 写 SSE 事件失败被吞掉，函数继续跑完并把结果写入任务文档（后台续跑）
 *   - 若函数被杀，靠 process-queue 的 recoverStuckJobs 从断点恢复
 */
export async function GET(req) {
  var jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return new Response("missing jobId", { status: 400 });
  }

  // 查找任务
  var job = null;
  try {
    var res = await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
      { q: "", filter: 'id = "' + jobId + '"', limit: 1 },
      { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
    );
    job = (res.data.hits || [])[0];
  } catch (err) {
    return new Response("查询任务失败: " + err.message, { status: 500 });
  }

  if (!job) {
    return new Response("任务不存在", { status: 404 });
  }

  // 任务已完成 → 直接推一个 complete 事件并关闭（EventSource 重连时命中）
  if (job.status === "completed" || job.status === "failed") {
    return sseFromEvents([{ type: job.status === "completed" ? "complete" : "fatal", data: { results: job.results || [], message: job.error || "" } }]);
  }

  // 锁定任务（防止并发：process-queue 的 recoverStuckJobs 用 2min cutoff）
  await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
    [{ id: jobId, status: "processing", processingLock: Date.now(), aiPhase: "starting", updatedAt: Date.now() }],
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );

  // 心跳：每 25s 刷新 processingLock，防止后台恢复机制误抢活跃任务
  var lastLockUpdate = Date.now();
  async function heartbeat() {
    var now = Date.now();
    if (now - lastLockUpdate < 25000) return;
    lastLockUpdate = now;
    try {
      await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
        [{ id: jobId, processingLock: now, updatedAt: now }],
        { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
      );
    } catch (_) {}
  }

  // SSE 流：onEvent 写入流（客户端断开则写入失败被吞，函数继续）
  var encoder = new TextEncoder();
  var clientAlive = true;

  var stream = new ReadableStream({
    async start(controller) {
      function send(type, data) {
        if (!clientAlive) return; // 客户端已断开，不再尝试写流（但流水线继续）
        try {
          var payload = "event: " + type + "\ndata: " + JSON.stringify(data || {}) + "\n\n";
          controller.enqueue(encoder.encode(payload));
        } catch (_) {
          clientAlive = false;
        }
      }

      // 初始事件
      send("start", { jobId: jobId, total: (job.files || []).length });

      try {
        var result = await runPipeline(job, {
          onEvent: function (type, data) {
            // 把流水线的 "error" 重命名为 "fatal"，避免与 EventSource 原生 error 事件冲突
            send(type === "error" ? "fatal" : type, data);
          },
          heartbeat: heartbeat,
        });

        // 写入最终状态
        await updateJobStatus(jobId, result.success ? "completed" : "failed", result.results, result.error);

        if (result.success) {
          send("complete", { results: result.results });
        } else {
          send("fatal", { stage: "final", message: result.error || "处理失败", results: result.results });
        }
      } catch (err) {
        console.error("[stream] 流水线异常:", err.message);
        try { await updateJobStatus(jobId, "failed", [], err.message); } catch (_) {}
        send("fatal", { stage: "exception", message: err.message });
      } finally {
        try { controller.close(); } catch (_) {}
      }
    },
    cancel() {
      // 客户端断开（关闭页面）
      clientAlive = false;
      console.log("[stream] 客户端断开，流水线转入后台继续");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function updateJobStatus(jobId, status, results, error) {
  await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
    [{ id: jobId, status: status, results: results || [], error: error || null, processingLock: 0, aiPhase: status, updatedAt: Date.now() }],
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );
}

/** 任务已结束时，直接返回一个一次性 SSE 响应 */
function sseFromEvents(events) {
  var encoder = new TextEncoder();
  var stream = new ReadableStream({
    start(controller) {
      events.forEach(function (ev) {
        controller.enqueue(encoder.encode("event: " + ev.type + "\ndata: " + JSON.stringify(ev.data || {}) + "\n\n"));
      });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
