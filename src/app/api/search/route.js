export const dynamic = "force-dynamic";
import axios from "axios";

export async function POST(req) {
  try {
    const { q, filter } = await req.json();

    // 支持逗号分隔的多关键词：所有词必须同时匹配（AND 逻辑）
    var query = q || "";
    var hasComma = /[,，]/.test(query);
    if (hasComma) {
      // 逗号换成空格，Meilisearch 默认 OR，用 matchingStrategy: all 强制 AND
      query = query.replace(/[,，]+/g, " ").trim();
    }

    var searchParams = {
      q: query || "",
      limit: 50,
      attributesToSearchOn: ["title", "summary", "tags"],
    };

    // 多关键词时要求所有词必须匹配 (AND)
    if (hasComma && query) {
      searchParams.matchingStrategy = "all";
    }

    // 如果有关键词筛选条件，传递给 Meilisearch
    if (filter) {
      searchParams.filter = filter;
    }

    const res = await axios.post(
      `${process.env.MEILISEARCH_HOST}/indexes/design_images/search`,
      searchParams,
      {
        headers: {
          Authorization: `Bearer ${process.env.MEILISEARCH_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return Response.json(res.data);
  } catch (error) {
    console.error("搜索错误:", error);
    // 优雅降级：搜索失败时返回空结果，而不是 500 错误
    return Response.json({ hits: [] });
  }
}
