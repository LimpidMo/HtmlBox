import { issueSession, jsonResponse, readJson, timingSafeEqual } from "../common.js";

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

    return jsonResponse({
        success: true,
        token: session.token,
        expiresAt: session.expiresAt
    });
}
