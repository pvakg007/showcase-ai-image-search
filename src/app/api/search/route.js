export const dynamic = "force-dynamic";
import axios from "axios";

var HOST = process.env.MEILISEARCH_HOST;
var KEY = process.env.MEILISEARCH_API_KEY;
var HEADERS = { Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

/**
 * 幂等确保 spaceName / projectName 可被搜索。
 * Meilisearch 设置是异步 task，首次调用后几秒内生效；生效前靠 doSearch 的 400 降级兜底。
 */
var settingsEnsured = false;
function ensureIndexSettings() {
  if (settingsEnsured) return;
  settingsEnsured = true;
  axios.patch(HOST + "/indexes/design_images/settings",
    { searchableAttributes: ["title", "summary", "tags", "spaceName", "projectName", "spaceNames"] },
    { headers: HEADERS }
  ).then(function () {
    console.log("[search] 已更新可搜索字段，加入 spaceName/projectName");
  }).catch(function (err) {
    settingsEnsured = false; // 失败则下次重试
    console.warn("[search] 更新索引设置失败:", err.message);
  });
}

/**
 * 执行搜索；若 attributesToSearchOn 引发 400（字段尚未标记为可搜索），回退为不限定字段重试。
 */
async function doSearch(searchParams) {
  try {
    return await axios.post(HOST + "/indexes/design_images/search", searchParams, { headers: HEADERS });
  } catch (err) {
    if (err.response && err.response.status === 400) {
      var fallback = Object.assign({}, searchParams);
      delete fallback.attributesToSearchOn;
      console.warn("[search] attributesToSearchOn 400，回退为全字段搜索");
      return await axios.post(HOST + "/indexes/design_images/search", fallback, { headers: HEADERS });
    }
    throw err;
  }
}

export async function POST(req) {
  try {
    ensureIndexSettings(); // fire-and-forget 自愈

    const { q, filter, page } = await req.json();

    var pageNum = parseInt(page) || 1;
    var limit = 20;
    var offset = (pageNum - 1) * limit;

    // 支持逗号分隔的多关键词：所有词必须同时匹配（AND 逻辑）
    var query = q || "";
    var hasComma = /[,，]/.test(query);
    if (hasComma) {
      query = query.replace(/[,，]+/g, " ").trim();
    }

    var searchParams = {
      q: query || "",
      limit: limit,
      offset: offset,
      attributesToSearchOn: ["title", "summary", "tags", "spaceName", "projectName"],
    };

    if (hasComma && query) {
      searchParams.matchingStrategy = "all";
    }

    if (filter) {
      searchParams.filter = filter;
    }

    const res = await doSearch(searchParams);
    return Response.json(res.data);
  } catch (error) {
    console.error("搜索错误:", error.message);
    return Response.json({ hits: [] });
  }
}
