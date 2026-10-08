// 后端共享模块：必须放在 functions/ 之外，否则会被 Pages 当成公开路由
// KV 键约定：site:list / site:<slug> / auth:session:<token>

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SLUG_PATTERN = /^[a-z0-9-]+$/;
// 页名：扁平文件名，允许扩展名但不含路径，如 a.html、style.css
const PAGE_NAME_PATTERN = /^[a-z0-9._-]+$/;

const MAX_TAG_LENGTH = 16;
const MAX_TAGS = 10;
const MAX_DESCRIPTION_LENGTH = 20;

// 固定路由与接口前缀占用的路径，禁止作为站点 slug（发布时校验）
const RESERVED_SLUGS = ["admin", "login", "index", "api", "assets"];

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

// 沙盒内页名：扁平文件名，允许扩展名但不含路径，如 a.html、style.css
export function isValidPageName(name) {
    return PAGE_NAME_PATTERN.test(name);
}

// ===== 标签 =====

// 标签保留词：与首页私有筛选项同义，避免用户标签和私有筛选混淆
const RESERVED_TAGS = ["私有", "private", "privatepage", "已私有"];
// 中英文逗号都算分隔符，中文用户易误输全角
const TAG_SEPARATOR = /[,，]/;

// 规范化标签：去空、去重、限长限条；非法返回中文错误
export function normalizeTags(raw) {
    if (!raw) {
        return { tags: "" };
    }
    if (typeof raw !== "string") {
        return { error: "标签格式不正确，请用逗号分隔的文本" };
    }
    const seen = new Set();
    const tags = [];
    for (const part of raw.split(TAG_SEPARATOR)) {
        const tag = part.trim();
        if (!tag) continue;

        if (tag.length > MAX_TAG_LENGTH) {
            return { error: `标签「${tag}」超过 ${MAX_TAG_LENGTH} 个字符` };
        }
        if (RESERVED_TAGS.includes(tag.toLowerCase())) {
            return { error: `标签「${tag}」是保留词，请换一个` };
        }
        if (seen.has(tag)) continue;

        seen.add(tag);
        tags.push(tag);
    }

    if (tags.length > MAX_TAGS) {
        return { error: `标签最多 ${MAX_TAGS} 个，当前 ${tags.length} 个` };
    }
    return { tags: tags.join(",") };
}

// 描述与前端 maxlength 对齐，API 直发也要受限
export function normalizeDescription(raw) {
    const text = raw ? String(raw).trim() : "";
    if (text.length > MAX_DESCRIPTION_LENGTH) {
        return { error: `描述最多 ${MAX_DESCRIPTION_LENGTH} 个字符` };
    }
    return { description: text };
}

export function isReservedSlug(slug) {
    return RESERVED_SLUGS.includes(slug);
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

// 页面导航不带 Authorization 头，必须支持 Cookie 会话，否则登录后直接访问私有页会 302 死循环
export function getBearerToken(request) {
    const header = request.headers.get("Authorization") || "";
    if (header.startsWith("Bearer ")) {
        return header.slice(7);
    }
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
    return match ? match[1] : "";
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

export function pageNamesOf(site) {
    return (site && site.pages || []).map(p => p.name).filter(Boolean);
}
