/**
 * 管理后台登录 API
 *
 * POST /api/admin/login
 * Body: { username: string, password: string }
 * Response: { success, token?, error? }
 *
 * 验证优先级：
 *   1. Vercel 环境变量 ADMIN_USERNAME / ADMIN_PASSWORD
 *   2. COS 设置文件 config/ai-settings.json 中的 adminUsername / adminPassword
 */
import COS from "cos-nodejs-sdk-v5";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

async function readSettings() {
  try {
    var data = await new Promise(function (resolve, reject) {
      cos.getObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: "config/ai-settings.json",
      }, function (err, d) { if (err) reject(err); else resolve(d); });
    });
    var body = Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body);
    return JSON.parse(body.toString("utf-8"));
  } catch (_) {
    return {};
  }
}

export async function POST(req) {
  try {
    var { username, password } = await req.json();

    // 1. 环境变量验证
    var envOk = (
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    );

    if (envOk) {
      var token = Buffer.from(username + ":" + password).toString("base64");
      return Response.json({ success: true, token: token, source: "env" });
    }

    // 2. COS 设置文件验证（后备）
    var settings = await readSettings();
    if (
      settings.adminUsername === username &&
      settings.adminPassword === password
    ) {
      var token2 = Buffer.from(username + ":" + password).toString("base64");
      return Response.json({ success: true, token: token2, source: "settings" });
    }

    // 3. 环境变量也未设置 → 提示初始化
    if (!process.env.ADMIN_USERNAME) {
      return Response.json(
        { success: false, error: "管理员账号未初始化", needSetup: true },
        { status: 401 }
      );
    }

    return Response.json(
      { success: false, error: "用户名或密码错误" },
      { status: 401 }
    );
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 400 }
    );
  }
}
