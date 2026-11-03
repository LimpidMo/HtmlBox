import {
    canonicalCacheKey,
    cleanSlug,
    deleteSiteRecord,
    getSite,
    getSiteList,
    isReservedSlug,
    isValidPageName,
    isValidSlug,
    jsonResponse,
    loadSiteMetas,
    MAX_PAGES,
    MAX_PAGE_BYTES,
    MAX_TOTAL_BYTES,
    normalizeDescription,
    normalizeTags,
    pageNamesOf,
    purgeApiSitesCache,
    purgePageCache,
    readJson,
    removeSiteMeta,
    saveSite,
    saveSiteList,
    saveSiteMeta,
    verifySession,
    withCacheHit
} from "../common.js";

// max-age=0：浏览器每次回源（避免管理端看到旧列表）；s-maxage：CDN 边缘缓存
const CACHE_MAX_AGE = 86400;

// 校验器统一约定：非法返回 Response（可直接作响应体），合法返回 null 或数据

// 校验标签与描述，通过时返回可写入站点的字段
function validateMeta(body) {
    const tags = normalizeTags(body.tags);
    if (tags.error) {
        return jsonResponse({ error: tags.error }, 400);
    }
    const description = normalizeDescription(body.description);
    if (description.error) {
        return jsonResponse({ error: description.error }, 400);
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
function validatePageNames(pageNames) {
    const seen = new Set();
    for (const name of pageNames) {
        if (!name) {
            return jsonResponse({ error: "每个页面都要填页面名，首个页面即沙盒入口" }, 400);
        }
        if (!isValidPageName(name)) {
            return jsonResponse({ error: `页面名「${name}」只能包含小写字母、数字、连字符、下划线和点` }, 400);
        }
        if (seen.has(name)) {
            return jsonResponse({ error: `页面名「${name}」重复` }, 400);
        }
        seen.add(name);
    }
    return null;
}

// 体积上限（KV 单值上限 25MB，留足余量）
function validateContent(pages) {
    if (pages.length > MAX_PAGES) {
        return jsonResponse({ error: `页面数最多 ${MAX_PAGES} 个，当前 ${pages.length} 个` }, 400);
    }
    let totalBytes = 0;
    for (const page of pages) {
        const size = new TextEncoder().encode(page.html || "").length;
        if (size > MAX_PAGE_BYTES) {
            return jsonResponse({ error: `页面「${page.name}」超过 ${formatMb(MAX_PAGE_BYTES)} 限制` }, 400);
        }
        totalBytes += size;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
        return jsonResponse({ error: `总内容超过 ${formatMb(MAX_TOTAL_BYTES)} 限制` }, 400);
    }
    return null;
}

function formatMb(bytes) {
    return `${Math.round(bytes / 1024 / 1024)}MB`;
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
        return jsonResponse({ error: "无效的请求体" }, 400);
    }

    const { slug, title, html } = body;
    if (!slug || !title || !html) {
        return jsonResponse({ error: "缺少必要字段: slug, title, html" }, 400);
    }

    const cleanSlugValue = cleanSlug(slug);
    if (!isValidSlug(cleanSlugValue)) {
        return jsonResponse({ error: "slug 只能包含小写字母、数字和连字符" }, 400);
    }

    if (isReservedSlug(cleanSlugValue)) {
        return jsonResponse({ error: "该 slug 是保留路径，请换一个" }, 400);
    }

    return { body, slug: cleanSlugValue };
}

// 单页站造一条仅用于体积校验，页名用清洗后的 slug（原始 slug 可能带斜杠）
function contentPagesOf(body, slug) {
    const pages = body.pages || [];
    return pages.length ? pages : [{ name: slug, html: body.html }];
}

// 创建与更新共用的输入校验：非法返回 Response，合法返回可直接落库的数据
async function validateSiteInput(request) {
    const parsed = await readSiteBody(request);
    if (parsed instanceof Response) return parsed;

    const pages = parsed.body.pages || [];
    // 页名只对多页站有意义：单页站没有页名概念，别把 slug 当页名校验
    const invalid = (pages.length ? validatePageNames(pages.map(p => p.name ?? "")) : null)
        || validateContent(contentPagesOf(parsed.body, parsed.slug));
    if (invalid) return invalid;

    const meta = validateMeta(parsed.body);
    if (meta instanceof Response) return meta;

    return { slug: parsed.slug, body: parsed.body, meta };
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

    // 只取元数据快照：一次 KV 读，且响应不含 html 正文
    const allSites = await loadSiteMetas(env);
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

// 全站备份导出：完整站点对象（含 html），仅管理员可读，不进 Cache API
export async function exportSites(request, env) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;

    const list = await getSiteList(env);
    const sites = (await Promise.all(list.map(slug => getSite(env, slug)))).filter(Boolean);

    return jsonResponse({ exportedAt: Date.now(), sites }, 200, {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="htmlbox-backup.json"'
    });
}

// 单站详情：含 html 与 pages 正文，仅管理员可读（编辑时用）
export async function getSiteDetail(request, env, slug) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;

    if (!slug || !isValidSlug(slug)) {
        return jsonResponse({ error: "slug 不合法" }, 400);
    }

    const site = await getSite(env, slug);
    if (!site) {
        return jsonResponse({ error: "网站不存在" }, 404);
    }

    return jsonResponse({ site }, 200, { "Cache-Control": "no-store" });
}

export async function createSite(request, env) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;

    const input = await validateSiteInput(request);
    if (input instanceof Response) return input;

    if (await getSite(env, input.slug)) {
        return jsonResponse({ error: "该 slug 已存在" }, 409);
    }

    const site = buildSite(input.body, Date.now(), input.meta);

    const list = await getSiteList(env);
    if (!list.includes(site.slug)) {
        list.push(site.slug);
        await saveSiteList(env, list);
    }

    await saveSite(env, site);
    await saveSiteMeta(env, site);
    await purgeApiSitesCache(request);
    await purgePageCache(request, site.slug, pageNamesOf(site));

    return jsonResponse({ success: true, site });
}

export async function updateSite(request, env) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;

    const input = await validateSiteInput(request);
    if (input instanceof Response) return input;

    const existing = await getSite(env, input.slug);
    if (!existing) {
        return jsonResponse({ error: "网站不存在" }, 404);
    }

    const site = buildSite(input.body, existing.createdAt, input.meta);

    await saveSite(env, site);
    await saveSiteMeta(env, site);
    await purgeApiSitesCache(request);
    // 旧页名 ∪ 新页名：删掉的页面其缓存条目也必须清掉，否则旧页面仍可访问
    const pageNames = [...new Set([...pageNamesOf(existing), ...pageNamesOf(site)])];
    await purgePageCache(request, site.slug, pageNames);

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
    await deleteSiteRecord(env, slug);
    await removeSiteMeta(env, slug);
    await purgeApiSitesCache(request);
    await purgePageCache(request, slug, pageNamesOf(existing));

    return jsonResponse({ success: true });
}
