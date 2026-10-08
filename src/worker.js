import { canonicalCacheKey, getSite, htmlResponse, withCacheHit } from "./common.js";
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

// KV 动态工具页：路由与 KV 命中之外一律返回 null 交回 404
async function siteResponse(slug, request, env, waitUntil) {
    const cacheKey = canonicalCacheKey(request);

    try {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
            return withCacheHit(cached);
        }
    } catch (e) {
        console.log("Cache not available:", e.message);
    }

    const parts = slug.split("/");
    const site = await getSite(env, parts[0]);
    if (!site) {
        return null;
    }

    let response;
    const subSlug = parts[1];
    if (subSlug && site.pages && site.pages.length > 0) {
        // 多页面项目：命中子 slug 返回子页面，未命中返回 404
        const subPage = site.pages.find(p => p.slug === subSlug);
        response = subPage ? htmlResponse(subPage.html) : notFound();
    } else {
        response = site.html ? htmlResponse(site.html) : null;
    }

    if (!response) {
        return null;
    }

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
