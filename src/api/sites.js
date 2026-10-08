import {
    canonicalCacheKey,
    cleanSlug,
    getSite,
    getSiteList,
    isReservedSlug,
    isValidSlug,
    isValidPageName,
    normalizeDescription,
    normalizeTags,
    jsonResponse,
    purgeApiSitesCache,
    purgePageCache,
    readJson,
    saveSite,
    saveSiteList,
    pageNamesOf,
    verifySession,
    withCacheHit
} from "../common.js";

// max-age=0：浏览器每次回源（避免管理端看到旧列表）；s-maxage：CDN 边缘缓存
const CACHE_MAX_AGE = 86400;

// 校验标签与描述，非法返回 {error}；通过返回可用于 buildSite 的字段
function validateMeta(body) {
    const tags = normalizeTags(body.tags);
    if (tags.error) {
        return { error: jsonResponse({ error: tags.error }, 400) };
    }
    const description = normalizeDescription(body.description);
    if (description.error) {
        return { error: jsonResponse({ error: description.error }, 400) };
    }
    return { tags: tags.tags, description: description.description };
}

function buildSite(body, createdAt, meta) {
    return {
        slug: cleanSlug(body.slug),
        title: body.title,
        tags: meta.tags,
        description: meta.description,
        html: body.html,
        pages: body.pages || null,
        // 以 pages 为唯一事实源：忽略 body.isMultiPage，避免两者不一致时站点形态与提交意图相反
        isMultiPage: !!body.pages,
        // 仅接受 public/private，其余值按 public；历史数据缺字段也按 public
        visibility: body.visibility === "private" ? "private" : "public",
        createdAt,
        updatedAt: Date.now()
    };
}

// 页名只在沙盒内生效（不做跨站唯一）：必须命名（首条即入口）、字符集合法、组内不重复
async function validatePageNames(pageNames) {
    const seen = new Set();
    for (const name of pageNames) {
        if (!name) {
            return { error: jsonResponse({ error: "每个页面都要填页面名，首个页面即沙盒入口" }, 400) };
        }
        if (!isValidPageName(name)) {
            return { error: jsonResponse({ error: `页面名「${name}」只能包含小写字母、数字、连字符、下划线和点` }, 400) };
        }
        if (seen.has(name)) {
            return { error: jsonResponse({ error: `页面名「${name}」重复` }, 400) };
        }
        seen.add(name);
    }
    return null;
}

async function requireAuth(request, env) {
    if (!await verifySession(request, env)) {
        return jsonResponse({ error: "未登录或登录已过期" }, 401);
    }
    return null;
}

async function readSiteBody(request) {
    const body = await readJson(request);
    if (!body) {
        return { error: jsonResponse({ error: "无效的请求体" }, 400) };
    }

    const { slug, title, html } = body;
    if (!slug || !title || !html) {
        return { error: jsonResponse({ error: "缺少必要字段: slug, title, html" }, 400) };
    }

    const cleanSlugValue = cleanSlug(slug);
    if (!isValidSlug(cleanSlugValue)) {
        return { error: jsonResponse({ error: "slug 只能包含小写字母、数字和连字符" }, 400) };
    }

    if (isReservedSlug(cleanSlugValue)) {
        return { error: jsonResponse({ error: "该 slug 是保留路径，请换一个" }, 400) };
    }

    return { body, slug: cleanSlugValue };
}

export async function getSites(request, env, waitUntil) {
    const cacheKey = canonicalCacheKey(request);
    // 带有效 token 的请求直接绕过缓存：响应按登录态过滤，进了未登录键会泄私有站
    const session = await verifySession(request, env);

    if (!session) {
        try {
            const cached = await caches.default.match(cacheKey);
            if (cached) {
                return withCacheHit(cached);
            }
        } catch (e) {
            console.log("Cache not available:", e.message);
        }
    }

    const list = await getSiteList(env);
    const allSites = (await Promise.all(list.map(slug => getSite(env, slug)))).filter(Boolean);
    // 未登录不含私有站
    const sites = session ? allSites : allSites.filter(s => s.visibility !== "private");

    const response = jsonResponse({ sites }, 200, {
        "Cache-Control": `public, max-age=0, s-maxage=${CACHE_MAX_AGE}`
    });

    if (!session) {
        waitUntil((async () => {
            try {
                await caches.default.put(cacheKey, response.clone());
            } catch (e) {
                console.log("Cache put failed:", e.message);
            }
        })());
    }

    return response;
}

export async function createSite(request, env) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;

    const { error, body, slug } = await readSiteBody(request);
    if (error) return error;

    if (await getSite(env, slug)) {
        return jsonResponse({ error: "该 slug 已存在" }, 409);
    }

    const nameError = await validatePageNames((body.pages || []).map(p => p.name ?? ""));
    if (nameError) return nameError.error;

    const meta = validateMeta(body);
    if (meta.error) return meta.error;

    const site = buildSite(body, Date.now(), meta);

    const list = await getSiteList(env);
    if (!list.includes(site.slug)) {
        list.push(site.slug);
        await saveSiteList(env, list);
    }

    await saveSite(env, site);
    await purgeApiSitesCache(request);
    await purgePageCache(request, site.slug, pageNamesOf(site));

    return jsonResponse({ success: true, site });
}

export async function updateSite(request, env) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;

    const { error, body, slug } = await readSiteBody(request);
    if (error) return error;

    const existing = await getSite(env, slug);
    if (!existing) {
        return jsonResponse({ error: "网站不存在" }, 404);
    }

    const nameError = await validatePageNames((body.pages || []).map(p => p.name ?? ""));
    if (nameError) return nameError.error;

    const meta = validateMeta(body);
    if (meta.error) return meta.error;

    const site = buildSite(body, existing.createdAt, meta);

    await saveSite(env, site);
    await purgeApiSitesCache(request);
    await purgePageCache(request, site.slug, pageNamesOf(site));

    return jsonResponse({ success: true, site });
}

export async function deleteSite(request, env) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;

    const slug = new URL(request.url).searchParams.get("slug");
    if (!slug) {
        return jsonResponse({ error: "缺少 slug 参数" }, 400);
    }

    const list = await getSiteList(env);
    if (!list.includes(slug)) {
        return jsonResponse({ error: "网站不存在" }, 404);
    }

    const existing = await getSite(env, slug);

    await saveSiteList(env, list.filter(s => s !== slug));
    await env.KV.delete(`site:${slug}`);
    await purgeApiSitesCache(request);
    await purgePageCache(request, slug, pageNamesOf(existing));

    return jsonResponse({ success: true });
}
