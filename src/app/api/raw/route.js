/**
 * 代理接口：从 COS 拉取 Markdown / JSON 内容并返回。
 * 解决浏览器跨域（CORS）无法直接 fetch COS 文件的问题。
 *
 * GET /api/raw?url=https://...
 */
export async function GET(req) {
  var url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return new Response("Missing url", { status: 400 });
  }

  // 安全检查：只允许 COS 域名
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return new Response("Invalid url", { status: 400 });
  }

  try {
    var res = await fetch(url);
    if (!res.ok) {
      return new Response(
        "Failed to fetch: HTTP " + res.status,
        { status: res.status }
      );
    }
    var text = await res.text();

    return new Response(text, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return new Response("Fetch error: " + err.message, { status: 502 });
  }
}
