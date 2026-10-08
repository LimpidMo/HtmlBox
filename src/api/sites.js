import {
    canonicalCacheKey,
    cleanSlug,
    getSite,
    getSiteList,
    isValidSlug,
    jsonResponse,
    purgeApiSitesCache,
    purgePageCache,
    readJson,
    saveSite,
    saveSiteList,
    subSlugsOf,
    verifySession,
    withCacheHit
} from "../common.js";

// max-age=0：浏览器每次回源（避免管理端看到旧列表）；s-maxage：CDN 边缘缓存
const CACHE_MAX_AGE = 86400;

function buildSite(body, createdAt) {
    return {
        slug: cleanSlug(body.slug),
        title: body.title,
        tags: body.tags || "",
        description: body.description || "",
        html: body.html,
        pages: body.pages || null,
        isMultiPage: body.isMultiPage || !!body.pages,
        createdAt,
        updatedAt: Date.now()
    };
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

    return { body, slug: cleanSlugValue };
}

export async function getSites(request, env, waitUntil) {
    const cacheKey = canonicalCacheKey(request);

    try {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
            return withCacheHit(cached);
        }
    } catch (e) {
        console.log("Cache not available:", e.message);
    }

    const list = await getSiteList(env);
    const sites = (await Promise.all(list.map(slug => getSite(env, slug)))).filter(Boolean);

    const response = jsonResponse({ sites }, 200, {
        "Cache-Control": `public, max-age=0, s-maxage=${CACHE_MAX_AGE}`
    });

    waitUntil((async () => {
        try {
            await caches.default.put(cacheKey, response.clone());
        } catch (e) {
            console.log("Cache put failed:", e.message);
        }
    })());

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

    const site = buildSite(body, Date.now());

    const list = await getSiteList(env);
    if (!list.includes(site.slug)) {
        list.push(site.slug);
        await saveSiteList(env, list);
    }

    await saveSite(env, site);
    await purgeApiSitesCache(request);
    await purgePageCache(request, site.slug, subSlugsOf(site));

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

    const site = buildSite(body, existing.createdAt);

    await saveSite(env, site);
    await purgeApiSitesCache(request);
    await purgePageCache(request, site.slug, subSlugsOf(site));

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
    await purgePageCache(request, slug, subSlugsOf(existing));

    return jsonResponse({ success: true });
}
