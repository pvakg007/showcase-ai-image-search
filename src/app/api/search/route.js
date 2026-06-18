import axios from "axios";

export async function POST(req) {
  try {
    const { q, filter } = await req.json();

    const searchParams = {
      q: q || "",
      limit: 50,
      attributesToSearchOn: ["title", "summary", "tags"],
    };

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
