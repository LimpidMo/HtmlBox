import {
    clearLoginFailures,
    issueSession,
    jsonResponse,
    readJson,
    readLoginFailures,
    recordLoginFailure,
    SESSION_TTL_MS,
    timingSafeEqual
} from "../common.js";

// 登录限速按 IP 计
function clientIp(request) {
    const header = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
    return header.split(",")[0].trim();
}

export async function login(request, env) {
    if (!env.ADMIN_PASSWORD) {
        return jsonResponse({ error: "服务器未配置管理员密码" }, 500);
    }

    const ip = clientIp(request);
    // 一次读拿到封禁状态与窗口记录，失败计数直接复用，避免二次读 KV
    const failures = await readLoginFailures(env, ip);
    if (failures.blocked) {
        return jsonResponse({ error: "尝试次数过多，请稍后再试" }, 429);
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
        await recordLoginFailure(env, ip, failures.record);
        return jsonResponse({ error: "密码错误" }, 401);
    }

    await clearLoginFailures(env, ip);
    const session = await issueSession(env);

    // HttpOnly Cookie：token 不落 localStorage，发布页面的脚本读不到管理员凭据
    // Secure 只在 https 下加，否则本地 http dev 浏览器不落盘、导航鉴权失效
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    const cookie = `session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;

    return jsonResponse({
        success: true,
        expiresAt: session.expiresAt
    }, 200, { "Set-Cookie": cookie });
}
