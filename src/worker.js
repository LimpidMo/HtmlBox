import { canonicalCacheKey, getSite, htmlResponse, verifySession, withCacheHit } from "./common.js";
import { pages, assets } from "./entries.js";
import { login } from "./api/login.js";
import { checkAuth, logout } from "./api/logout.js";
import { createSite, deleteSite, getSites, updateSite } from "./api/sites.js";

// 页面与内嵌资源的边缘缓存头：无 SSR 敏感数据（登录态在客户端判断），可短时缓存
const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=3600";
// workerd 禁止在 global scope 构造 Response，只能留在函数内创建
function notFound() {
    return new Response("Not Found", { status: 404 });
}

function pageResponse(html) {
    return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": PAGE_CACHE_CONTROL }
    });
}

function assetResponse(asset) {
    return new Response(asset.body, {
        headers: { "Content-Type": asset.contentType, "Cache-Control": PAGE_CACHE_CONTROL }
    });
}

// 沙盒渲染：首条页面即入口（如 a.html），其余按页名精确匹配
function resolvePage(site, pageName) {
    const pages = site.pages || [];
    if (pages.length === 0) {
        // 单页站：整站就是一页，任意子路径都非法
        return pageName ? null : { html: site.html };
    }
    if (!pageName) {
        return null;
    }
    return pages.find(p => p.name === pageName) || null;
}

// 沙盒页渲染，公开私有共用：子页跟随主页的可见性
function renderSitePage(site, pageName) {
    const page = resolvePage(site, pageName);
    return page && page.html ? htmlResponse(page.html) : notFound();
}

// 主 slug 重定向到入口页：让页内相对链接以 /slug/ 为基准解析
function redirectToEntry(site, request) {
    const entry = (site.pages || [])[0];
    if (!entry || !entry.name) return null;
    const url = new URL(request.url);
    url.pathname = `/${site.slug}/${entry.name}`;
    return Response.redirect(url, 302);
}

// 站点级响应：私有先判登录（302 到登录页），之后主 slug 跳入口、渲染页
async function respondWithSite(site, pageName, request, env, waitUntil) {
    if (site.visibility === "private") {
        if (!await verifySession(request, env)) {
            const url = new URL(request.url);
            const next = encodeURIComponent(url.pathname + url.search);
            return Response.redirect(new URL(`/login?next=${next}`, url.origin), 302);
        }
    }

    // 主 slug（无页名）：多页沙盒跳入口页，单页站直接渲染
    if (!pageName) {
        const entryRedirect = redirectToEntry(site, request);
        if (entryRedirect) return entryRedirect;
    }

    if (site.visibility === "private") {
        const privatePage = renderSitePage(site, pageName);
        return new Response(privatePage.body, {
            status: privatePage.status,
            // fromEntries 出来的键是小写，覆盖时必须同小写，否则两个键被 Headers 合并成串联值
            headers: { ...Object.fromEntries(privatePage.headers), "cache-control": "no-store" }
        });
    }

    const cacheKey = canonicalCacheKey(request);

    try {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
            return withCacheHit(cached);
        }
    } catch (e) {
        console.log("Cache not available:", e.message);
    }

    const response = renderSitePage(site, pageName);

    if (response.status === 200) {
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

// KV 动态沙盒页：/<slug>（index 页）、/<slug>/<页名>
async function siteResponse(slug, request, env, waitUntil) {
    const parts = slug.split("/");
    const site = await getSite(env, parts[0]);
    if (!site) {
        return null;
    }
    return respondWithSite(site, parts[1], request, env, waitUntil);
}

async function handleApi(path, method, request, env, waitUntil) {
    if (path === "/api/auth/login" && method === "POST") {
        return login(request, env);
    }

    if (path === "/api/auth/logout") {
        return method === "POST" ? logout(request, env) : checkAuth(request, env);
    }

    if (path === "/api/sites") {
        switch (method) {
            case "GET": return getSites(request, env, waitUntil);
            case "POST": return createSite(request, env);
            case "PUT": return updateSite(request, env);
            case "DELETE": return deleteSite(request, env);
        }
    }

    return null;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = request.method;

        // 固定页面路由（含 .html 旧链接兼容）
        if (path === "/" || path === "/index" || path === "/index.html") return pageResponse(pages.index);
        if (path === "/admin" || path === "/admin.html") return pageResponse(pages.admin);
        if (path === "/login" || path === "/login.html") return pageResponse(pages.login);

        // 内嵌静态资源：theme.css / common.js / favicon.svg
        const asset = assets[path];
        if (asset) return assetResponse(asset);

        if (path.startsWith("/api/")) {
            const apiResponse = await handleApi(path, method, request, env, ctx.waitUntil.bind(ctx));
            // API 前缀保留给接口，不落到 KV 动态页
            return apiResponse || notFound();
        }

        // KV 动态工具页
        const response = await siteResponse(path.slice(1), request, env, ctx.waitUntil.bind(ctx));
        return response || notFound();
    }
};
