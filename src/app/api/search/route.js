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

    // 归一化分隔符（逗号/顿号）为空格，再按空格分词
    var normalized = String(q || "").replace(/[,，、]+/g, " ").trim();
    var tokens = normalized.split(/\s+/).filter(Boolean);

    // 分离正向词与负向词（- 开头 → 排除该词）
    var positive = [];
    var negative = [];
    tokens.forEach(function (t) {
      if (t.charAt(0) === "-" && t.length > 1) negative.push(t.slice(1));
      else if (t !== "-") positive.push(t);
    });

    var query = positive.join(" ").trim();

    var searchParams = {
      q: query,
      limit: limit,
      offset: offset,
      attributesToSearchOn: ["title", "summary", "tags", "spaceName", "projectName"],
    };

    // 多正向词要求全部匹配 (AND)
    if (positive.length > 1) {
      searchParams.matchingStrategy = "all";
    }

    // 组合 filter：客户端选中的 tag filter + 负向排除 (NOT tags = "词")
    var filterParts = [];
    if (filter) filterParts.push(filter);
    negative.forEach(function (w) {
      // 排除 tags 中含有该词的图片
      filterParts.push('NOT tags = "' + w.replace(/"/g, "") + '"');
    });
    if (filterParts.length > 0) {
      searchParams.filter = filterParts.join(" AND ");
    }

    const res = await doSearch(searchParams);
    return Response.json(res.data);
  } catch (error) {
    console.error("搜索错误:", error.message);
    return Response.json({ hits: [] });
  }
}
