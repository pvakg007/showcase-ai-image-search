/**
 * 首次初始化管理员账号
 *
 * POST /api/admin/setup
 * Body: { username: string, password: string }
 *
 * 仅在环境变量 ADMIN_USERNAME 未设置时可用（首次部署）。
 * 将凭据写入 COS config/ai-settings.json，之后可通过 login API 登录。
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

async function writeSettings(settings) {
  await new Promise(function (resolve, reject) {
    cos.putObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: "config/ai-settings.json",
      Body: Buffer.from(JSON.stringify(settings, null, 2), "utf-8"),
      ContentType: "application/json; charset=utf-8",
    }, function (err, d) { if (err) reject(err); else resolve(d); });
  });
}

export async function POST(req) {
  try {
    // 如果环境变量已设置，禁止使用此接口
    if (process.env.ADMIN_USERNAME) {
      return Response.json({
        success: false,
        error: "环境变量 ADMIN_USERNAME 已设置，请直接使用登录页面",
      }, { status: 403 });
    }

    var { username, password } = await req.json();

    if (!username || !password) {
      return Response.json({
        success: false,
        error: "用户名和密码不能为空",
      }, { status: 400 });
    }

    if (username.length < 2) {
      return Response.json({
        success: false,
        error: "用户名至少 2 个字符",
      }, { status: 400 });
    }

    if (password.length < 4) {
      return Response.json({
        success: false,
        error: "密码至少 4 个字符",
      }, { status: 400 });
    }

    // 写入 COS 设置文件
    var current = await readSettings();
    current.adminUsername = username;
    current.adminPassword = password;
    await writeSettings(current);

    var token = Buffer.from(username + ":" + password).toString("base64");

    return Response.json({
      success: true,
      token: token,
      message: "管理员账号初始化成功",
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
