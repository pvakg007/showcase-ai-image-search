export const dynamic = "force-dynamic";
import COS from "cos-nodejs-sdk-v5";
import axios from "axios";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

/**
 * 验证管理员身份
 * Authorization header: Basic <base64(username:password)>
 */
function verifyAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith("Basic ")) return false;
  try {
    var encoded = authHeader.slice(6);
    var decoded = Buffer.from(encoded, "base64").toString("utf-8");
    var colon = decoded.indexOf(":");
    var user = decoded.slice(0, colon);
    var pass = decoded.slice(colon + 1);
    return (
      user === process.env.ADMIN_USERNAME &&
      pass === process.env.ADMIN_PASSWORD
    );
  } catch (_) {
    return false;
  }
}

/**
 * 认证失败响应
 */
function unauthorized() {
  return Response.json({ success: false, error: "未授权" }, { status: 401 });
}

/**
 * 从 COS URL 中提取 Object Key
 */
function extractKey(url) {
  try {
    var u = new URL(url);
    return u.pathname.replace(/^\//, "");
  } catch (_) {
    return null;
  }
}

/**
 * 删除单个图片文件 + Meilisearch 记录
 */
async function deleteSingleItem(id, url, mdUrl) {
  var deleted = [];

  // 1. 从 Meilisearch 删除
  try {
    await axios.delete(
      process.env.MEILISEARCH_HOST + "/indexes/design_images/documents/" + id,
      { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY } }
    );
    deleted.push("Meilisearch");
  } catch (err) {
    console.warn("Meilisearch 删除失败:", err.message);
  }

  // 2. 从 COS 删除图片
  if (url) {
    var imageKey = extractKey(url);
    if (imageKey) {
      try {
        await new Promise(function (resolve, reject) {
          cos.deleteObject(
            { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: imageKey },
            function (err) { if (err) reject(err); else resolve(); }
          );
        });
        deleted.push("图片文件");
      } catch (err) {
        console.warn("COS 图片删除失败:", err.message);
      }
    }
  }

  // 3. 从 COS 删除总结
  if (mdUrl) {
    var mdKey = extractKey(mdUrl);
    if (mdKey) {
      try {
        await new Promise(function (resolve, reject) {
          cos.deleteObject(
            { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: mdKey },
            function (err) { if (err) reject(err); else resolve(); }
          );
        });
        deleted.push("总结文件");
      } catch (err) {
        console.warn("COS 总结删除失败:", err.message);
      }
    }
  }

  return deleted;
}

// ============================================================
//  GET — 搜索/列出所有图片
// ============================================================
export async function GET(req) {
  var auth = req.headers.get("authorization");
  if (!verifyAuth(auth)) return unauthorized();

  var q = req.nextUrl.searchParams.get("q") || "";
  var page = parseInt(req.nextUrl.searchParams.get("page")) || 1;
  var limit = parseInt(req.nextUrl.searchParams.get("limit")) || 50;
  var offset = (page - 1) * limit;

  try {
    var searchParams = {
      q: q || "",
      limit: limit,
      offset: offset,
      attributesToSearchOn: ["title", "summary", "tags", "spaceName", "projectName"],
    };

    var res = await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/design_images/search",
      searchParams,
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
      total: res.data.estimatedTotalHits || res.data.hits?.length || 0,
      page: page,
      limit: limit,
    });
  } catch (err) {
    console.error("管理后台查询失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ============================================================
//  PUT — 更新图片信息（title / summary / tags）
// ============================================================
export async function PUT(req) {
  var auth = req.headers.get("authorization");
  if (!verifyAuth(auth)) return unauthorized();

  try {
    var body = await req.json();
    var { id, title, summary, tags } = body;

    if (!id) {
      return Response.json(
        { success: false, error: "缺少 id" },
        { status: 400 }
      );
    }

    // 构建更新文档（只包含需要修改的字段）
    var doc = { id: id };
    if (title !== undefined) doc.title = title;
    if (summary !== undefined) doc.summary = summary;
    if (tags !== undefined) doc.tags = tags;

    // 同步更新 Meilisearch
    await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/design_images/documents",
      [doc],
      {
        headers: {
          Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    return Response.json({ success: true, data: doc });
  } catch (err) {
    console.error("管理后台更新失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ============================================================
//  DELETE — 删除图片（支持单张和批量）
// ============================================================
export async function DELETE(req) {
  var auth = req.headers.get("authorization");
  if (!verifyAuth(auth)) return unauthorized();

  try {
    var body = await req.json();
    var { id, url, mdUrl, items } = body;

    // 批量删除
    if (Array.isArray(items) && items.length > 0) {
      var overallDeleted = [];
      for (var item of items) {
        var d = await deleteSingleItem(item.id, item.url, item.mdUrl);
        overallDeleted.push.apply(overallDeleted, d);
      }
      return Response.json({
        success: true,
        message: "批量删除完成，共处理 " + items.length + " 项",
        deleted: overallDeleted,
      });
    }

    // 单张删除
    if (!id) {
      return Response.json({ success: false, error: "缺少 id" }, { status: 400 });
    }

    var deleted = await deleteSingleItem(id, url, mdUrl);

    return Response.json({
      success: true,
      message: "已删除: " + deleted.join("、"),
    });
  } catch (err) {
    console.error("管理后台删除失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
