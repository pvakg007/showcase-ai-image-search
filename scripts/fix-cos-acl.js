/**
 * 一次性脚本：设置 COS 存储桶和已有文件的公共读权限
 * 运行: node scripts/fix-cos-acl.js
 */
require("dotenv").config({ path: ".env.local" });
const COS = require("cos-nodejs-sdk-v5");

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION;

if (!BUCKET || !REGION) {
  console.error("请设置 COS_BUCKET 和 COS_REGION 环境变量");
  process.exit(1);
}

async function main() {
  console.log("设置存储桶 ACL 为 public-read...");
  try {
    await cos.putBucketAcl({
      Bucket: BUCKET,
      Region: REGION,
      ACL: "public-read",
    });
    console.log("✓ 存储桶 ACL 已设置");
  } catch (err) {
    console.error("× 存储桶 ACL 设置失败:", err.message);
  }

  console.log("列出已有文件...");
  let files = [];
  try {
    const result = await cos.getBucket({
      Bucket: BUCKET,
      Region: REGION,
    });
    files = result.Contents || [];
    console.log("找到 " + files.length + " 个文件");
  } catch (err) {
    console.error("× 列出文件失败:", err.message);
  }

  for (let i = 0; i < files.length; i++) {
    const key = files[i].Key;
    try {
      await cos.putObjectAcl({
        Bucket: BUCKET,
        Region: REGION,
        Key: key,
        ACL: "public-read",
      });
      console.log("  ✓ " + key);
    } catch (err) {
      console.error("  × " + key + ": " + err.message);
    }
  }

  console.log("完成！");
}

main().catch(console.error);
