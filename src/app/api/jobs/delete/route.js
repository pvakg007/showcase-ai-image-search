export const dynamic = "force-dynamic";
import axios from "axios";

/**
 * POST /api/jobs/delete — 删除处理任务（管理员）
 * Body: { jobId }
 * 仅从 processing_jobs 索引删除任务记录；不删已生成的图片（design_images 里的成品保留）。
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
    if (!jobId) return Response.json({ success: false, error: "缺少 jobId" }, { status: 400 });

    await axios.delete(
      process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents/" + encodeURIComponent(jobId),
      { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY } }
    );
    return Response.json({ success: true, message: "任务已删除" });
  } catch (err) {
    console.error("删除任务失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
