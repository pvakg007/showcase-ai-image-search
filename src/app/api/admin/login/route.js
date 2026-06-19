/**
 * 管理后台登录 API
 *
 * POST /api/admin/login
 * Body: { username: string, password: string }
 * Response: { success, token?, error? }
 *
 * 验证通过后返回 base64 编码的 token，所有后续管理 API 需在
 * Authorization header 中带上 `Basic <token>`。
 */
export async function POST(req) {
  try {
    var { username, password } = await req.json();

    if (
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      var token = Buffer.from(username + ":" + password).toString("base64");
      return Response.json({ success: true, token: token });
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
