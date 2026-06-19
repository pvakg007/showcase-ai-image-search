export const dynamic = "force-dynamic";
import axios from "axios";

/**
 * GET /api/jobs/list — 列出所有处理任务（管理员）
 *
 * Query params:
 *   status — 过滤状态 (pending/processing/completed/failed)
 *   page   — 页码（默认 1）
 *   limit  — 每页数量（默认 50）
 */
export async function GET(req) {
  var auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  // 验证
  var user, pass;
  try {
    var decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
    var colon = decoded.indexOf(":");
    user = decoded.slice(0, colon);
    pass = decoded.slice(colon + 1);
  } catch (_) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }
  if (user !== process.env.ADMIN_USERNAME || pass !== process.env.ADMIN_PASSWORD) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    var page = parseInt(req.nextUrl.searchParams.get("page")) || 1;
    var limit = parseInt(req.nextUrl.searchParams.get("limit")) || 50;
    var statusFilter = req.nextUrl.searchParams.get("status") || "";

    var searchParams = {
      q: "",
      limit: limit,
      offset: (page - 1) * limit,
      sort: ["createdAt:desc"],
    };

    if (statusFilter) {
      searchParams.filter = 'status = "' + statusFilter + '"';
    }

    var res = await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/search",
      searchParams,
      {
        headers: {
          Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    var jobs = (res.data.hits || []).map(function (j) {
      var total = (j.files || []).length;
      var done = (j.results || []).filter(function (r) { return r && r.status === "success"; }).length;
      var failed = (j.results || []).filter(function (r) { return r && r.status === "failed"; }).length;
      return {
        id: j.id,
        type: j.type,
        status: j.status,
        projectName: j.projectName || "",
        totalImages: total,
        processed: done,
        failed: failed,
        retryCount: j.retryCount || 0,
        maxRetries: j.maxRetries || 2,
        nextRetryAt: j.nextRetryAt || null,
        processingLock: j.processingLock || 0,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        files: (j.files || []).map(function (f, fi) {
          var r = (j.results || [])[fi];
          return {
            originalName: f.originalName,
            spaceNames: f.spaceNames || [],
            status: r ? r.status : "pending",
            error: r ? r.error || "" : "",
          };
        }),
      };
    });

    return Response.json({
      success: true,
      data: jobs,
      total: res.data.estimatedTotalHits || jobs.length,
      page: page,
      limit: limit,
    });
  } catch (err) {
    console.error("列出任务失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
