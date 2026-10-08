import { issueSession, jsonResponse, readJson, SESSION_TTL_MS, timingSafeEqual } from "../common.js";

export async function login(request, env) {
    if (!env.ADMIN_PASSWORD) {
        return jsonResponse({ error: "服务器未配置管理员密码" }, 500);
    }

    const body = await readJson(request);
    if (!body) {
        return jsonResponse({ error: "无效的请求体" }, 400);
    }

    const { password } = body;
    if (!password) {
        return jsonResponse({ error: "请输入密码" }, 400);
    }

    if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
        return jsonResponse({ error: "密码错误" }, 401);
    }

    const session = await issueSession(env);

    // HttpOnly Cookie：浏览器导航私有页时自动携带（fetch 请求仍走 Authorization 头）
    // Secure 只在 https 下加，否则本地 http dev 浏览器不落盘、导航鉴权失效
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    const cookie = `session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;

    return jsonResponse({
        success: true,
        token: session.token,
        expiresAt: session.expiresAt
    }, 200, { "Set-Cookie": cookie });
}
