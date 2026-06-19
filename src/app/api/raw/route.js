export const dynamic = "force-dynamic";
import COS from "cos-nodejs-sdk-v5";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

/**
 * 从 COS 完整 URL 中提取 Object Key
 * URL 格式：https://<bucket-appid>.cos.<region>.myqcloud.com/<key>
 */
function extractKeyFromCosUrl(url) {
  try {
    var u = new URL(url);
    // 去掉开头的 /
    return u.pathname.replace(/^\//, "");
  } catch (_) {
    return null;
  }
}

/**
 * 代理接口：从 COS 拉取 Markdown / JSON 内容并返回。
 *
 * 策略：
 *   1. COS 域名 → 用 COS SDK（带鉴权）拉取，不依赖 public-read
 *   2. 非 COS 域名 → 用 fetch 拉取（后备）
 *
 * GET /api/raw?url=https://...
 */
export async function GET(req) {
  var url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return new Response("Missing url", { status: 400 });
  }

  // 基础 URL 校验
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return new Response("Invalid url", { status: 400 });
  }

  // === 策略 1: COS SDK（支持鉴权，不依赖 public-read） ===
  if (url.includes(".cos.") && url.includes("myqcloud.com")) {
    try {
      var key = extractKeyFromCosUrl(url);
      if (key) {
        console.log("[raw] COS SDK fetching:", key);
        var data = await new Promise(function (resolve, reject) {
          cos.getObject(
            {
              Bucket: process.env.COS_BUCKET,
              Region: process.env.COS_REGION,
              Key: key,
            },
            function (err, result) {
              if (err) reject(err);
              else resolve(result);
            }
          );
        });
        return new Response(data.Body.toString("utf-8"), {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    } catch (err) {
      console.warn("[raw] COS SDK 失败，回退到 fetch:", err.message);
    }
  }

  // === 策略 2: 普通 fetch（后备） ===
  try {
    var res = await fetch(url);
    if (!res.ok) {
      return new Response(
        "Failed to fetch: HTTP " + res.status,
        { status: res.status }
      );
    }
    return new Response(await res.text(), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return new Response("Fetch error: " + err.message, { status: 502 });
  }
}
