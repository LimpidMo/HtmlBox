import { getBearerToken, jsonResponse, revokeSession, verifySession } from "../common.js";

export async function logout(request, env) {
    const session = await verifySession(request, env);
    if (!session) {
        return jsonResponse({ error: "未登录或登录已过期" }, 401);
    }

    await revokeSession(env, getBearerToken(request));

    return jsonResponse({ success: true });
}

export async function checkAuth(request, env) {
    const session = await verifySession(request, env);

    if (!session) {
        return jsonResponse({ authenticated: false }, 401);
    }

    return jsonResponse({ authenticated: true });
}
