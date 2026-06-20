export const dynamic = "force-dynamic";
import axios from "axios";

/**
 * 查询任务状态
 * GET /api/jobs/status?jobId=xxx
 */
export async function GET(req) {
  var jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return Response.json({ success: false, error: "缺少 jobId" }, { status: 400 });
  }

  try {
    var res = await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
      {
        q: jobId,
        attributesToSearchOn: ["id"],
        limit: 1,
      },
      {
        headers: {
          Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
        },
      }
    );

    var hits = res.data.hits || [];
    if (hits.length === 0) {
      return Response.json({ success: false, error: "任务不存在" }, { status: 404 });
    }

    var job = hits[0];

    // 统计进度
    var total = (job.files || []).length;
    var done = (job.results || []).filter(function (r) {
      return r.status === "success";
    }).length;
    var failed = (job.results || []).filter(function (r) {
      return r.status === "failed";
    }).length;

    return Response.json({
      success: true,
      data: {
        id: job.id,
        type: job.type,
        status: job.status,
        projectName: job.projectName || "",
        totalImages: total,
        processed: done,
        failed: failed,
        retryCount: job.retryCount || 0,
        error: job.error || "",
        results: (job.results || []).filter(function (r) {
          return r.status === "success";
        }).map(function (r) {
          return {
            title: r.title,
            mdUrl: r.mdUrl,
            url: r.url,
            tags: r.tags,
            spaceNames: r.spaceNames,
          };
        }),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        // AI 分析实时状态
        aiStartedAt: job.aiStartedAt || 0,
        aiPhase: job.aiPhase || "",
        aiElapsedMs: job.aiElapsedMs || 0,
      },
    });
  } catch (err) {
    console.error("查询任务状态失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
