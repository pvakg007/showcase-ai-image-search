export const dynamic = "force-dynamic";
/**
 * 管理后台 — AI 服务商设置 API
 *
 * GET  /api/admin/settings  — 读取当前设置（AI 地址 + 模型名）
 * PUT  /api/admin/settings  — 更新设置
 *
 * 设置存储在 COS 的 config/ai-settings.json 中。
 * process-queue 会优先读取 COS 设置，再回退到环境变量。
 */
import COS from "cos-nodejs-sdk-v5";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

const SETTINGS_KEY = "config/ai-settings.json";

const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION;

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

function unauthorized() {
  return Response.json({ success: false, error: "未授权" }, { status: 401 });
}

/**
 * 从 COS 读取设置文件
 */
async function readSettings() {
  try {
    var data = await new Promise(function (resolve, reject) {
      cos.getObject({
        Bucket: BUCKET,
        Region: REGION,
        Key: SETTINGS_KEY,
      }, function (err, d) { if (err) reject(err); else resolve(d); });
    });
    var body = Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body);
    return JSON.parse(body.toString("utf-8"));
  } catch (_) {
    return {};
  }
}

/**
 * 写入设置文件到 COS
 */
async function writeSettings(settings) {
  await new Promise(function (resolve, reject) {
    cos.putObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: SETTINGS_KEY,
      Body: Buffer.from(JSON.stringify(settings, null, 2), "utf-8"),
      ContentType: "application/json; charset=utf-8",
    }, function (err, d) { if (err) reject(err); else resolve(d); });
  });
}

// ============================================================
//  GET — 读取当前设置
// ============================================================
export async function GET(req) {
  var auth = req.headers.get("authorization");
  if (!verifyAuth(auth)) return unauthorized();

  try {
    var settings = await readSettings();

    // 合并环境变量作为默认值（COS 设置优先）
    return Response.json({
      success: true,
      data: {
        aiUrl: settings.aiUrl || process.env.SPARK_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
        aiModel: settings.aiModel || process.env.SPARK_MODEL || "qwen3.6-plus",
        aiPrompt: settings.aiPrompt || "",
        envUrl: process.env.SPARK_API_URL || "",
        envModel: process.env.SPARK_MODEL || "",
      },
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ============================================================
//  PUT — 更新设置
// ============================================================
export async function PUT(req) {
  var auth = req.headers.get("authorization");
  if (!verifyAuth(auth)) return unauthorized();

  try {
    var body = await req.json();

    // 只允许修改 aiUrl 和 aiModel
    var updates = {};
    if (body.aiUrl !== undefined) updates.aiUrl = body.aiUrl.replace(/\/+$/, "").replace("/chat/completions", "");
    if (body.aiModel !== undefined) updates.aiModel = body.aiModel.trim();
    if (body.aiPrompt !== undefined) updates.aiPrompt = body.aiPrompt.trim();

    var current = await readSettings();
    var merged = { ...current, ...updates };

    await writeSettings(merged);

    return Response.json({
      success: true,
      data: merged,
      message: "设置已保存（下次处理任务时生效）",
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
