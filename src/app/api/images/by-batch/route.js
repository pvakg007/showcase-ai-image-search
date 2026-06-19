import axios from "axios";

/**
 * 获取同一批次上传的图片
 *
 * GET /api/images/by-batch?batchId=xxx
 */
export async function GET(req) {
  var batchId = req.nextUrl.searchParams.get("batchId");
  if (!batchId) {
    return Response.json({ success: false, error: "缺少 batchId" }, { status: 400 });
  }

  try {
    var res = await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/design_images/search",
      {
        q: "",
        filter: 'batchId = "' + batchId + '"',
        limit: 50,
      },
      {
        headers: {
          Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    return Response.json({
      success: true,
      data: res.data.hits || [],
    });
  } catch (err) {
    console.error("按批次查询失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
