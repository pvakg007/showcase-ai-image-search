export const dynamic = "force-dynamic";
import COS from "cos-nodejs-sdk-v5";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

/**
 * 一次性维护接口：给存储桶和已有文件设置公共读权限。
 * 部署后访问一次即可，之后可删除此文件。
 *
 * GET /api/fix-acl
 */
export async function GET() {
  var logs = [];
  var bucket = process.env.COS_BUCKET;
  var region = process.env.COS_REGION;

  if (!bucket || !region) {
    return Response.json({ error: "COS_BUCKET 或 COS_REGION 未设置" }, { status: 500 });
  }

  // 1. 设置存储桶 ACL
  try {
    await cos.putBucketAcl({
      Bucket: bucket,
      Region: region,
      ACL: "public-read",
    });
    logs.push("✓ 存储桶 ACL 已设为 public-read");
  } catch (err) {
    logs.push("× 存储桶 ACL 失败: " + err.message);
  }

  // 2. 列出已有文件
  var files = [];
  try {
    var result = await cos.getBucket({
      Bucket: bucket,
      Region: region,
    });
    files = result.Contents || [];
    logs.push("找到 " + files.length + " 个文件");
  } catch (err) {
    logs.push("× 列文件失败: " + err.message);
  }

  // 3. 逐个设置公共读
  for (var i = 0; i < files.length; i++) {
    var key = files[i].Key;
    try {
      await cos.putObjectAcl({
        Bucket: bucket,
        Region: region,
        Key: key,
        ACL: "public-read",
      });
      logs.push("  ✓ " + key);
    } catch (err) {
      logs.push("  × " + key + ": " + err.message);
    }
  }

  return Response.json({ success: true, total: files.length, logs: logs });
}
