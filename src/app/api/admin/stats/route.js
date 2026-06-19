import COS from "cos-nodejs-sdk-v5";
import axios from "axios";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

/**
 * 验证管理员身份
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
 * 统计 COS 存储信息（支持分页列出所有文件）
 */
async function listAllCosObjects(bucket, region) {
  var allObjects = [];
  var marker = "";

  try {
    while (true) {
      var result = await new Promise(function (resolve, reject) {
        cos.getBucket(
          {
            Bucket: bucket,
            Region: region,
            Marker: marker || undefined,
            MaxKeys: 1000,
          },
          function (err, data) {
            if (err) reject(err);
            else resolve(data);
          }
        );
      });

      var contents = result.Contents || [];
      allObjects.push.apply(allObjects, contents);

      if (!result.IsTruncated) break;
      marker = result.NextMarker || contents[contents.length - 1]?.Key || "";
    }
  } catch (err) {
    console.warn("COS 列文件失败:", err.message);
  }

  return allObjects;
}

/**
 * 获取存储统计
 * GET /api/admin/stats
 */
export async function GET(req) {
  var auth = req.headers.get("authorization");
  if (!verifyAuth(auth)) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    var bucket = process.env.COS_BUCKET;
    var region = process.env.COS_REGION;

    // 1. 统计 COS 文件
    var allFiles = await listAllCosObjects(bucket, region);
    var totalSize = allFiles.reduce(function (sum, f) {
      return sum + (f.Size || 0);
    }, 0);

    var imageFiles = allFiles.filter(function (f) {
      return f.Key && f.Key.startsWith("images/");
    });
    var summaryFiles = allFiles.filter(function (f) {
      return f.Key && f.Key.startsWith("summaries/");
    });

    // 2. 统计 Meilisearch 索引
    var totalImages = 0;
    try {
      var res = await axios.post(
        process.env.MEILISEARCH_HOST + "/indexes/design_images/search",
        { q: "", limit: 0 },
        {
          headers: {
            Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
          },
        }
      );
      totalImages = res.data.estimatedTotalHits || 0;
    } catch (err) {
      console.warn("Meilisearch 查询失败:", err.message);
    }

    // 格式化大小
    var sizeFormatted =
      totalSize < 1024 * 1024
        ? (totalSize / 1024).toFixed(1) + " KB"
        : totalSize < 1024 * 1024 * 1024
        ? (totalSize / 1024 / 1024).toFixed(1) + " MB"
        : (totalSize / 1024 / 1024 / 1024).toFixed(2) + " GB";

    return Response.json({
      success: true,
      data: {
        totalImages: totalImages,
        cosFiles: {
          total: allFiles.length,
          images: imageFiles.length,
          summaries: summaryFiles.length,
          totalSizeBytes: totalSize,
          totalSizeFormatted: sizeFormatted,
        },
      },
    });
  } catch (err) {
    console.error("统计查询失败:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
