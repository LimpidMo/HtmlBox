// 后端共享模块：必须放在 functions/ 之外，否则会被 Pages 当成公开路由
// KV 键约定：site:list / site:<slug> / auth:session:<token>

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

// ===== 响应 =====

export function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...extraHeaders }
    });
}

export function htmlResponse(html) {
    return new Response(html, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=86400"
        }
    });
}

// ===== 解析 =====

export async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

export function parseJson(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// ===== slug =====

export function cleanSlug(raw) {
    return raw.replace(/^\/+|\/+$/g, "");
}

export function isValidSlug(slug) {
    return SLUG_PATTERN.test(slug);
}

// ===== 鉴权 =====

export function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

export function getBearerToken(request) {
    const header = request.headers.get("Authorization") || "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export async function issueSession(env) {
    const token = generateToken();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await env.KV.put(`auth:session:${token}`, JSON.stringify({ expiresAt }), {
        expirationTtl: SESSION_TTL_MS / 1000
    });
    return { token, expiresAt };
}

// 返回 session 对象或 null（过期会话顺带删除）
export async function verifySession(request, env) {
    const token = getBearerToken(request);
    if (!token) return null;

    const raw = await env.KV.get(`auth:session:${token}`);
    if (!raw) return null;

    const session = parseJson(raw);
    if (!session || session.expiresAt < Date.now()) {
        await env.KV.delete(`auth:session:${token}`);
        return null;
    }
    return session;
}

export async function revokeSession(env, token) {
    if (token) {
        await env.KV.delete(`auth:session:${token}`);
    }
}

function generateToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, "0")).join("");
}

// ===== 站点数据 =====

export async function getSiteList(env) {
    const list = parseJson(await env.KV.get("site:list"));
    return Array.isArray(list) ? list : [];
}

export async function saveSiteList(env, list) {
    await env.KV.put("site:list", JSON.stringify(list));
}

export async function getSite(env, slug) {
    const raw = await env.KV.get(`site:${slug}`);
    return raw ? parseJson(raw) : null;
}

export async function saveSite(env, site) {
    await env.KV.put(`site:${site.slug}`, JSON.stringify(site));
}

// ===== 缓存 =====

// 缓存键规范化：同一资源只存一条。query/hash 必须去掉（历史上前端带 ?t= 导致永不命中且无限堆积）
export function canonicalCacheKey(request, path) {
    const url = new URL(request.url);
    if (path) url.pathname = path;
    url.search = "";
    url.hash = "";
    return new Request(url.toString());
}

export function withCacheHit(response) {
    return new Response(response.body, {
        status: response.status,
        headers: { ...Object.fromEntries(response.headers), "X-Cache": "HIT" }
    });
}

async function safeDelete(key) {
    try {
        await caches.default.delete(key);
    } catch (e) {
        console.error("Cache delete error:", e);
    }
}

// 写操作后调用：精确删除已知键，不扫全量（caches.keys() 在 dev 未实现且生产代价高）
export async function purgeApiSitesCache(request) {
    await safeDelete(canonicalCacheKey(request, "/api/sites"));
}

// 删除 /{slug}、/{slug}/ 及已知子页面；禁止用 url.includes 前缀匹配（slug ab 会误删 /abc）
export async function purgePageCache(request, slug, subSlugs = []) {
    const paths = [`/${slug}`, `/${slug}/`, ...subSlugs.filter(Boolean).map(s => `/${slug}/${s}`)];
    await Promise.all(paths.map(p => safeDelete(canonicalCacheKey(request, p))));
}

export function subSlugsOf(site) {
    return (site && site.pages || []).map(p => p.slug).filter(Boolean);
}
