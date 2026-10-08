// src/common.js
var SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var SLUG_PATTERN = /^[a-z0-9-]+$/;
var PAGE_NAME_PATTERN = /^[a-z0-9._-]+$/;
var MAX_TAG_LENGTH = 16;
var MAX_TAGS = 10;
var MAX_DESCRIPTION_LENGTH = 20;
var RESERVED_SLUGS = ["admin", "login", "index", "api", "assets"];
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders }
  });
}
function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400"
    }
  });
}
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function cleanSlug(raw) {
  return raw.replace(/^\/+|\/+$/g, "");
}
function isValidSlug(slug) {
  return SLUG_PATTERN.test(slug);
}
function isValidPageName(name) {
  return PAGE_NAME_PATTERN.test(name);
}
var RESERVED_TAGS = ["私有", "private", "privatepage", "已私有"];
var TAG_SEPARATOR = /[,，]/;
function normalizeTags(raw) {
  if (!raw) {
    return { tags: "" };
  }
  if (typeof raw !== "string") {
    return { error: "标签格式不正确，请用逗号分隔的文本" };
  }
  const seen = /* @__PURE__ */ new Set();
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
function normalizeDescription(raw) {
  const text = raw ? String(raw).trim() : "";
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `描述最多 ${MAX_DESCRIPTION_LENGTH} 个字符` };
  }
  return { description: text };
}
function isReservedSlug(slug) {
  return RESERVED_SLUGS.includes(slug);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : "";
}
async function issueSession(env) {
  const token = generateToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await env.KV.put(`auth:session:${token}`, JSON.stringify({ expiresAt }), {
    expirationTtl: SESSION_TTL_MS / 1e3
  });
  return { token, expiresAt };
}
async function verifySession(request, env) {
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
async function revokeSession(env, token) {
  if (token) {
    await env.KV.delete(`auth:session:${token}`);
  }
}
function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function getSiteList(env) {
  const list = parseJson(await env.KV.get("site:list"));
  return Array.isArray(list) ? list : [];
}
async function saveSiteList(env, list) {
  await env.KV.put("site:list", JSON.stringify(list));
}
async function getSite(env, slug) {
  const raw = await env.KV.get(`site:${slug}`);
  return raw ? parseJson(raw) : null;
}
async function saveSite(env, site) {
  await env.KV.put(`site:${site.slug}`, JSON.stringify(site));
}
function canonicalCacheKey(request, path) {
  const url = new URL(request.url);
  if (path) url.pathname = path;
  url.search = "";
  url.hash = "";
  return new Request(url.toString());
}
function withCacheHit(response) {
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
async function purgeApiSitesCache(request) {
  await safeDelete(canonicalCacheKey(request, "/api/sites"));
}
async function purgePageCache(request, slug, subSlugs = []) {
  const paths = [`/${slug}`, `/${slug}/`, ...subSlugs.filter(Boolean).map((s) => `/${slug}/${s}`)];
  await Promise.all(paths.map((p) => safeDelete(canonicalCacheKey(request, p))));
}
function pageNamesOf(site) {
  return (site && site.pages || []).map((p) => p.name).filter(Boolean);
}

// src/pages/index.html
var pages_default = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HtmlBox - 网页盒子</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>
    <link rel="stylesheet" href="/assets/theme.css">
    <script src="/assets/common.js"><\/script>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        .card { transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
        .card:hover {
            transform: translateY(-8px);
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.15);
        }
        .card:hover .card-arrow { transform: translate(5px, -5px); opacity: 1; }
        .card-arrow { opacity: 0; transition: all 0.3s ease; }
        .loading { animation: pulse 1.5s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .fade-up { opacity: 0; transform: translateY(30px); animation: fadeUp 0.6s ease forwards; }
        @keyframes fadeUp { to { opacity: 1; transform: translateY(0); } }
        .tag { background: var(--border-color); color: var(--text-secondary); }
        .tag.active { background: var(--color-accent); color: white; }
    </style>
</head>
<body>
    <header class="py-8 px-6 border-b">
        <div class="max-w-6xl mx-auto flex items-center justify-between">
            <div>
                <h1 class="text-4xl font-bold">HtmlBox</h1>
                <p class="font-mono text-sm mt-1" style="color: var(--text-secondary);">Html Collection</p>
            </div>
            <div class="flex items-center gap-6">
                <nav class="flex gap-6 font-mono text-sm">
                    <a href="/" style="color: var(--text-primary);">首页</a>
                    <a href="/admin.html" style="color: var(--text-secondary);">管理</a>
                </nav>
                <button id="themeToggle" class="theme-toggle" title="切换主题">
                    <svg id="sunIcon" class="w-5 h-5 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
                    </svg>
                    <svg id="moonIcon" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
                    </svg>
                </button>
            </div>
        </div>
        <div id="filterBar" class="hidden max-w-6xl mx-auto mt-6 flex justify-end gap-2"></div>
    </header>

    <main class="max-w-6xl mx-auto px-6 py-16">
        <div id="loading" class="text-center py-20">
            <div class="font-mono text-sm loading" style="color: var(--text-secondary);">Loading...</div>
        </div>

        <div id="empty" class="hidden text-center py-20">
            <p class="font-mono text-lg" style="color: var(--text-secondary);">暂无工具</p>
            <a href="/admin.html" class="inline-block mt-6 text-[var(--color-accent)] font-mono text-sm hover:underline">立即添加 →</a>
        </div>

        <div id="sites" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"></div>
    </main>

    <footer class="py-8 px-6 border-t mt-auto">
        <div class="max-w-6xl mx-auto text-center font-mono text-xs" style="color: var(--text-secondary);">
            <p>Powered by <a href="https://github.com/LimpidMo/HtmlBox" target="_blank" class="hover:underline">LimpidMo</a></p>
        </div>
    </footer>

    <script>
        let allSites = [];
        let activeTag = null;
        // 私有筛选项的哨兵值：带前导冒号，不会与用户标签名冲突
        const PRIVATE_FILTER = ':private';

        async function loadSites() {
            const loading = document.getElementById('loading');
            const empty = document.getElementById('empty');
            const sitesEl = document.getElementById('sites');
            const filterBar = document.getElementById('filterBar');

            try {
                // 已登录（后台常驻）带头请求，服务端才会返回私有站；访客匿名看到公开列表
                const token = localStorage.getItem('token');
                const res = await fetch('/api/sites', token ? { headers: { 'Authorization': \`Bearer \${token}\` } } : {});
                const data = await res.json();
                allSites = data.sites || [];

                loading.classList.add('hidden');

                if (allSites.length === 0) {
                    empty.classList.remove('hidden');
                    return;
                }

                const tags = new Set();
                allSites.forEach(site => {
                    if (site.tags) {
                        site.tags.split(',').forEach(t => t.trim() && tags.add(t.trim()));
                    }
                });

                // 私有站只有登录态才会返回，出现即可认为已登录
                const hasPrivate = allSites.some(s => s.visibility === 'private');

                if (tags.size > 0 || hasPrivate) {
                    filterBar.classList.remove('hidden');
                    filterBar.innerHTML = \`
                        <button class="tag px-3 py-1 font-mono text-xs rounded-full \${!activeTag ? 'active' : ''}" data-tag="">全部</button>
                        \${hasPrivate ? \`<button class="tag px-3 py-1 font-mono text-xs rounded-full \${activeTag === PRIVATE_FILTER ? 'active' : ''}" data-tag="\${PRIVATE_FILTER}">私有</button>\` : ''}
                        \${Array.from(tags).map(tag => \`
                            <button class="tag px-3 py-1 font-mono text-xs rounded-full \${activeTag === tag ? 'active' : ''}" data-tag="\${escapeHtml(tag)}">\${escapeHtml(tag)}</button>
                        \`).join('')}
                    \`;
                    filterBar.querySelectorAll('.tag').forEach(btn => {
                        btn.addEventListener('click', () => {
                            activeTag = btn.dataset.tag;
                            filterBar.querySelectorAll('.tag').forEach(b => b.classList.remove('active'));
                            btn.classList.add('active');
                            renderSites();
                        });
                    });
                }

                renderSites();

            } catch (err) {
                loading.innerHTML = '<p class="text-red-500 font-mono">加载失败</p>';
            }
        }

        function renderSites() {
            const sitesEl = document.getElementById('sites');
            const empty = document.getElementById('empty');

            const filtered = activeTag === PRIVATE_FILTER
                ? allSites.filter(s => s.visibility === 'private')
                : activeTag
                    ? allSites.filter(s => s.tags && s.tags.split(',').map(t => t.trim()).includes(activeTag))
                    : allSites;

            if (filtered.length === 0) {
                empty.classList.remove('hidden');
                sitesEl.innerHTML = '';
                return;
            }

            empty.classList.add('hidden');
            sitesEl.innerHTML = filtered.map(site => \`
                <a href="/\${site.slug}" class="card block p-6 border fade-up" style="animation-fill-mode: both; background: var(--bg-card); border-color: var(--border-color);">
                    <div class="flex items-start justify-between mb-3">
                        <div class="flex items-center gap-2">
                            <span class="font-mono text-xs uppercase" style="color: var(--text-secondary);">/\${site.slug}</span>
                            \${site.visibility === 'private' ? '<span class="font-mono text-xs px-2 py-0.5 rounded-full" style="background: var(--border-color); color: var(--text-secondary);">私有</span>' : ''}
                            \${site.tags ? site.tags.split(',').map(t => t.trim()).filter(Boolean).map(tag => \`
                                <span class="tag px-2 py-0.5 font-mono text-xs rounded-full">\${escapeHtml(tag)}</span>
                            \`).join('') : ''}
                        </div>
                        <svg class="card-arrow w-4 h-4 text-[var(--color-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                        </svg>
                    </div>
                    <h2 class="text-xl font-bold mb-2" style="color: var(--text-primary); line-height: 1.3;">\${escapeHtml(site.title)}</h2>
                    \${site.description ? \`<p class="font-mono text-xs line-clamp-2" style="color: var(--text-secondary); line-height: 1.5;">\${escapeHtml(site.description)}</p>\` : ''}
                </a>
            \`).join('');
        }

        loadSites();
    <\/script>
</body>
</html>
`;

// src/pages/admin.html
var admin_default = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理 - HtmlBox</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>
    <link rel="stylesheet" href="/assets/theme.css">
    <script src="/assets/common.js"><\/script>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        .input-field {
            border: 2px solid var(--border-color);
            background: var(--bg-card);
            color: var(--text-primary);
            transition: all 0.3s ease;
        }
        .input-field:focus {
            border-color: var(--text-primary);
            outline: none;
        }
        .btn-primary {
            background: var(--text-primary);
            color: var(--bg-primary);
            transition: all 0.3s ease;
        }
        .btn-primary:hover { background: var(--color-accent); }
        .btn-secondary {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            transition: all 0.3s ease;
        }
        .btn-secondary:hover { border-color: var(--text-primary); color: var(--text-primary); }
        .btn-danger {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            transition: all 0.3s ease;
        }
        .btn-danger:hover { border-color: #ff4444; color: #ff4444; }
        .site-item { background: var(--bg-card); transition: all 0.3s ease; }
        .fade-in { animation: fadeIn 0.4s ease forwards; }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .page-entry { border-left: 3px solid var(--color-accent); }

        /* 必须 !important：.modal-overlay 的 display:flex 特异性同级且在注入顺序后，会盖掉 Tailwind 的 .hidden */
        .hidden { display: none !important; }

        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        .modal-content {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            padding: 24px;
            max-width: 400px;
            width: 90%;
        }
    </style>
</head>
<body>
    <header class="py-8 px-6 border-b bg-[var(--bg-card)]">
        <div class="max-w-4xl mx-auto flex items-center justify-between">
            <div>
                <h1 class="text-3xl font-bold">管理后台</h1>
                <p class="font-mono text-sm mt-1" style="color: var(--text-secondary);">Site Management</p>
            </div>
            <div class="flex items-center gap-4">
                <button id="themeToggle" class="theme-toggle" title="切换主题">
                    <svg id="sunIcon" class="w-5 h-5 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
                    </svg>
                    <svg id="moonIcon" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
                    </svg>
                </button>
                <a href="/" class="font-mono text-sm transition-colors" style="color: var(--text-secondary);">首页</a>
                <button id="logoutBtn" class="font-mono text-sm transition-colors" style="color: var(--text-secondary);">退出</button>
            </div>
        </div>
    </header>

    <main class="max-w-4xl mx-auto px-6 py-12">
        <div id="authError" class="hidden text-center py-20">
            <p style="color: var(--text-secondary);">请先登录</p>
            <a href="/login.html" class="text-[var(--color-accent)] font-mono text-sm hover:underline">前往登录 →</a>
        </div>

        <div id="content" class="hidden">
            <section class="mb-16">
                <h2 id="formTitle" class="text-xl font-bold mb-6 flex items-center gap-3">
                    <span class="w-2 h-2 bg-[var(--color-accent)] rounded-full"></span>
                    添加新网页
                </h2>

                <form id="addForm" class="bg-[var(--bg-card)] p-8 border fade-in" style="border-color: var(--border-color);">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div>
                            <label class="block font-mono text-xs mb-2 uppercase" style="color: var(--text-secondary);">访问路径 (Slug)</label>
                            <input type="text" name="slug" placeholder="my-tool 则访问路径为/my-tool" class="input-field w-full p-4 font-mono text-sm" required>
                        </div>
                        <div>
                            <label class="block font-mono text-xs mb-2 uppercase" style="color: var(--text-secondary);">标题</label>
                            <input type="text" name="title" placeholder="工具名称" class="input-field w-full p-4" required>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div>
                            <label class="block font-mono text-xs mb-2 uppercase" style="color: var(--text-secondary);">标签 (逗号分隔)</label>
                            <input type="text" name="tags" placeholder="文本,实用,生活" class="input-field w-full p-4 font-mono text-sm" maxlength="200">
                        </div>
                        <div>
                            <label class="block font-mono text-xs mb-2 uppercase" style="color: var(--text-secondary);">
                                描述 <span id="descCount" class="text-xs font-normal">(0 / 20)</span>
                            </label>
                            <input type="text" name="description" id="descriptionInput" placeholder="简要描述" class="input-field w-full p-4" maxlength="20">
                        </div>
                    </div>

                    <div class="mb-6">
                        <label class="block font-mono text-xs mb-2 uppercase" style="color: var(--text-secondary);">访问权限</label>
                        <div class="flex items-center gap-6">
                            <label class="flex items-center gap-2 text-sm" style="color: var(--text-secondary);">
                                <input type="radio" name="visibility" value="public" checked> 公开
                            </label>
                            <label class="flex items-center gap-2 text-sm" style="color: var(--text-secondary);">
                                <input type="radio" name="visibility" value="private"> 私有（需登录后访问，不出现在公开列表）
                            </label>
                        </div>
                    </div>

                    <div class="mb-6">
                        <label class="block font-mono text-xs mb-2 uppercase" style="color: var(--text-secondary);">
                            HTML 内容 <span class="text-xs font-normal">（首条为入口）</span>
                        </label>
                        <div id="pagesContainer">
                            <div class="page-entry p-4 mb-4">
                                <div class="flex gap-4 mb-2 hidden" data-name-row>
                                    <input type="text" name="pageName" placeholder="页面文件名如：index.html" class="input-field flex-1 p-2 font-mono text-sm">
                                </div>
                                <textarea name="html" placeholder="<html>...</html>" class="input-field w-full p-4 font-mono text-sm" rows="8" required></textarea>
                            </div>
                        </div>
                        <div class="flex items-center gap-3 mt-4">
                            <input type="checkbox" name="isMultiPage" id="isMultiPage" class="w-4 h-4">
                            <label for="isMultiPage" class="text-sm" style="color: var(--text-secondary);">多页面项目</label>
                            <button type="button" id="addPageBtn" class="hidden btn-secondary px-3 py-1 font-mono text-xs">+ 添加页面</button>
                        </div>
                    </div>

                    <div class="flex justify-end gap-3">
                        <button type="button" id="cancelEditBtn" class="hidden btn-secondary px-6 py-3 font-mono text-sm">取消</button>
                        <button type="submit" id="submitBtn" class="btn-primary px-8 py-3 font-mono text-sm uppercase tracking-wider">
                            发布
                        </button>
                    </div>
                </form>

                <div id="formMsg" class="mt-4 font-mono text-sm hidden"></div>
            </section>

            <section>
                <h2 class="text-xl font-bold mb-6 flex items-center gap-3">
                    <span class="w-2 h-2 bg-[var(--color-release)] rounded-full"></span>
                    已发布网页
                </h2>

                <div id="sitesList" class="space-y-4"></div>
            </section>
        </div>
    </main>

    <div id="deleteModal" class="modal-overlay hidden">
        <div class="modal-content">
            <h3 class="text-lg font-bold mb-4">确认删除</h3>
            <p class="mb-6" style="color: var(--text-secondary);">确定要删除 <span id="deleteSlug" class="font-mono"></span> 吗？此操作无法撤销。</p>
            <div class="flex justify-end gap-3">
                <button id="cancelDelete" class="btn-secondary px-6 py-2 font-mono text-sm">取消</button>
                <button id="confirmDelete" class="btn-danger px-6 py-2 font-mono text-sm">删除</button>
            </div>
        </div>
    </div>

    <script>
        // 确保删除弹窗默认隐藏
        document.getElementById('deleteModal').classList.add('hidden');

        const token = localStorage.getItem('token');
        const content = document.getElementById('content');
        const authError = document.getElementById('authError');
        const addForm = document.getElementById('addForm');
        const formMsg = document.getElementById('formMsg');
        const sitesList = document.getElementById('sitesList');
        const logoutBtn = document.getElementById('logoutBtn');
        const isMultiPage = document.getElementById('isMultiPage');
        const addPageBtn = document.getElementById('addPageBtn');
        const pagesContainer = document.getElementById('pagesContainer');
        const descriptionInput = document.getElementById('descriptionInput');
        const descCount = document.getElementById('descCount');
        const formTitle = document.getElementById('formTitle');
        const submitBtn = document.getElementById('submitBtn');
        const cancelEditBtn = document.getElementById('cancelEditBtn');
        const deleteModal = document.getElementById('deleteModal');
        const deleteSlugEl = document.getElementById('deleteSlug');
        const cancelDelete = document.getElementById('cancelDelete');
        const confirmDelete = document.getElementById('confirmDelete');

        let deleteTargetSlug = null;
        let editingSlug = null;

        descriptionInput.addEventListener('input', function() {
            descCount.textContent = \`(\${this.value.length} / 20)\`;
        });

        if (!token) {
            authError.classList.remove('hidden');
        } else {
            content.classList.remove('hidden');
            loadSites();
        }

        logoutBtn.addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': \`Bearer \${token}\` } });
            localStorage.removeItem('token');
            window.location.href = '/';
        });

        isMultiPage.addEventListener('change', function() {
            const nameRows = pagesContainer.querySelectorAll('[data-name-row]');
            if (this.checked) {
                addPageBtn.classList.remove('hidden');
                nameRows.forEach((row, idx) => {
                    row.classList.remove('hidden');
                    // 勾选时给首条预填入口名，省一次手动输入
                    if (idx === 0 && !row.querySelector('[name="pageName"]').value) {
                        row.querySelector('[name="pageName"]').value = 'index.html';
                    }
                });
            } else {
                addPageBtn.classList.add('hidden');
                nameRows.forEach(row => row.classList.add('hidden'));
                const entries = pagesContainer.querySelectorAll('.page-entry');
                if (entries.length > 1) {
                    entries[entries.length - 1].remove();
                }
            }
        });

        // 页面条目模板：填充（编辑）与初始态共用，删除按钮仅非首页条目可配
        // 页面名行仅多页面项目可见，由 isMultiPage 勾选态决定
        function renderPageEntry(page = {}, allowRemove = false) {
            const removeBtn = allowRemove
                ? \`<button type="button" onclick="this.closest('.page-entry').remove()" class="btn-danger px-2 py-1 font-mono text-xs">删除</button>\`
                : '';
            return \`
                <div class="page-entry p-4 mb-4">
                    <div class="flex gap-4 mb-2 \${isMultiPage.checked ? '' : 'hidden'}" data-name-row>
                        <input type="text" name="pageName" placeholder="页面文件名如：index.html" class="input-field flex-1 p-2 font-mono text-sm" value="\${escapeHtml(page.name || '')}">
                        \${removeBtn}
                    </div>
                    <textarea name="html" placeholder="<html>...</html>" class="input-field w-full p-4 font-mono text-sm" rows="8" required>\${escapeHtml(page.html || '')}</textarea>
                </div>
            \`;
        }

        function resetPagesContainer() {
            pagesContainer.innerHTML = renderPageEntry();
            addPageBtn.classList.add('hidden');
            isMultiPage.checked = false;
        }

        addPageBtn.addEventListener('click', function() {
            pagesContainer.insertAdjacentHTML('beforeend', renderPageEntry({}, true));
        });

        async function loadSites() {
            try {
                // 必须带 token：服务端按登录态过滤私有站，匿名请求拿不到私有列表
                const res = await fetch('/api/sites', { headers: { 'Authorization': \`Bearer \${token}\` } });
                const data = await res.json();
                const sites = data.sites || [];

                const renderItem = site => \`
                    <div class="site-item p-6 border flex items-center justify-between fade-in" style="border-color: var(--border-color);">
                        <div class="flex items-center gap-4">
                            <span class="w-2 h-2 \${site.visibility === 'private' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-release)]'} rounded-full"></span>
                            <div>
                                <h3 class="font-bold text-lg">\${escapeHtml(site.title)}</h3>
                                <p class="font-mono text-xs" style="color: var(--text-secondary);">/\${site.slug}\${site.tags ? ' · ' + site.tags.split(',').map(t => t.trim()).join(' · ') : ''}</p>
                            </div>
                        </div>
                        <div class="flex gap-3">
                            <a href="/\${site.slug}" target="_blank" class="font-mono text-xs px-3 py-2" style="color: var(--text-secondary);">查看</a>
                            <button onclick="editSite('\${site.slug}')" class="btn-secondary font-mono text-xs px-3 py-2">修改</button>
                            <button onclick="showDeleteModal('\${site.slug}')" class="btn-danger font-mono text-xs px-3 py-2">删除</button>
                        </div>
                    </div>
                \`;

                const publicSites = sites.filter(s => s.visibility !== 'private');
                const privateSites = sites.filter(s => s.visibility === 'private');

                sitesList.innerHTML = \`
                    <h3 class="text-lg font-bold mb-4 flex items-center gap-3">
                        <span class="w-2 h-2 bg-[var(--color-release)] rounded-full"></span>公开网页
                        <span class="font-mono text-xs" style="color: var(--text-secondary);">(\${publicSites.length})</span>
                    </h3>
                    <div class="space-y-4 mb-10">\${publicSites.map(renderItem).join('') || '<p class="font-mono text-sm text-center py-8" style="color: var(--text-secondary);">暂无公开网页</p>'}</div>
                    <h3 class="text-lg font-bold mb-4 flex items-center gap-3">
                        <span class="w-2 h-2 bg-[var(--color-accent)] rounded-full"></span>私有网页
                        <span class="font-mono text-xs" style="color: var(--text-secondary);">(\${privateSites.length})</span>
                    </h3>
                    <div class="space-y-4">\${privateSites.map(renderItem).join('') || '<p class="font-mono text-sm text-center py-8" style="color: var(--text-secondary);">暂无私有网页</p>'}</div>
                \`;

            } catch (err) {
                sitesList.innerHTML = '<p class="text-red-500 font-mono text-sm">加载失败</p>';
            }
        }

        cancelDelete.addEventListener('click', closeDeleteModal);

        deleteModal.addEventListener('click', function(e) {
            if (e.target === deleteModal) closeDeleteModal();
        });

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && !deleteModal.classList.contains('hidden')) closeDeleteModal();
        });

        function closeDeleteModal() {
            deleteModal.classList.add('hidden');
            deleteTargetSlug = null;
        }

        confirmDelete.addEventListener('click', async function() {
            if (!deleteTargetSlug) return;
            try {
                const res = await fetch(\`/api/sites?slug=\${deleteTargetSlug}\`, {
                    method: 'DELETE',
                    headers: { 'Authorization': \`Bearer \${token}\` }
                });
                const data = await res.json();
                if (data.success) {
                    closeDeleteModal();
                    loadSites();
                } else {
                    alert(data.error || '删除失败');
                }
            } catch (err) {
                alert('网络错误');
            }
            deleteTargetSlug = null;
        });

        window.showDeleteModal = function(slug) {
            if (!slug) return;
            deleteTargetSlug = slug;
            deleteSlugEl.textContent = '/' + slug;
            deleteModal.classList.remove('hidden');
        };

        window.editSite = async function(slug) {
            try {
                // 编辑私有站也要带 token，否则列表里找不到它
                const res = await fetch('/api/sites', { headers: { 'Authorization': \`Bearer \${token}\` } });
                if (!res.ok) throw new Error('API Error');
                const data = await res.json();
                const site = (data.sites || []).find(s => s.slug === slug);
                if (!site) {
                    alert('未找到该网页');
                    return;
                }

                editingSlug = slug;
                formTitle.textContent = '修改网页';
                submitBtn.textContent = '保存修改';
                cancelEditBtn.classList.remove('hidden');

                document.querySelector('[name="slug"]').value = site.slug;
                document.querySelector('[name="slug"]').disabled = true;
                document.querySelector('[name="title"]').value = site.title || '';
                document.querySelector('[name="tags"]').value = site.tags || '';
                document.querySelector('[name="description"]').value = site.description || '';
                const visibilityInput = document.querySelector(\`input[name="visibility"][value="\${site.visibility || 'public'}"]\`);
                if (visibilityInput) visibilityInput.checked = true;

                if (site.pages && site.pages.length > 0) {
                    isMultiPage.checked = true;
                    addPageBtn.classList.remove('hidden');
                    pagesContainer.innerHTML = site.pages.map((page, idx) => renderPageEntry(page, idx > 0)).join('');
                } else {
                    isMultiPage.checked = false;
                    addPageBtn.classList.add('hidden');
                    pagesContainer.innerHTML = renderPageEntry({ html: site.html || '' });
                }

                window.scrollTo({ top: 0, behavior: 'smooth' });
            } catch (err) {
                console.error('Edit error:', err);
                alert('加载失败: ' + err.message);
            }
        };

        cancelEditBtn.addEventListener('click', function() {
            editingSlug = null;
            formTitle.textContent = '添加新网页';
            submitBtn.textContent = '发布';
            cancelEditBtn.classList.add('hidden');
            document.querySelector('[name="slug"]').disabled = false;
            addForm.reset();
            resetPagesContainer();
        });

        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(addForm);

            const pageEntries = pagesContainer.querySelectorAll('.page-entry');
            const pages = Array.from(pageEntries).map(entry => ({
                name: entry.querySelector('[name="pageName"]').value.trim(),
                html: entry.querySelector('[name="html"]').value
            }));

            const payload = {
                slug: editingSlug || formData.get('slug'),
                title: formData.get('title'),
                tags: formData.get('tags'),
                description: formData.get('description'),
                html: pages[0].html,
                // 勾选多页面才建沙盒；不勾选时 pages 为 null，整站单页直接渲染
                pages: formData.get('isMultiPage') === 'on' ? pages : null,
                isMultiPage: formData.get('isMultiPage') === 'on',
                visibility: formData.get('visibility') || 'public'
            };

            try {
                const method = editingSlug ? 'PUT' : 'POST';
                const res = await fetch('/api/sites', {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': \`Bearer \${token}\`
                    },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();

                if (data.success) {
                    formMsg.textContent = editingSlug ? '修改成功！' : '发布成功！';
                    formMsg.className = 'mt-4 font-mono text-sm text-green-600';
                    formMsg.classList.remove('hidden');

                    if (editingSlug) {
                        cancelEditBtn.click();
                    } else {
                        addForm.reset();
                        resetPagesContainer();
                    }
                    loadSites();
                } else {
                    formMsg.textContent = data.error || '发布失败';
                    formMsg.className = 'mt-4 font-mono text-sm text-red-600';
                    formMsg.classList.remove('hidden');
                }
            } catch (err) {
                formMsg.textContent = '网络错误';
                formMsg.className = 'mt-4 font-mono text-sm text-red-600';
                formMsg.classList.remove('hidden');
            }

            setTimeout(() => formMsg.classList.add('hidden'), 3000);
        });
    <\/script>
</body>
</html>
`;

// src/pages/login.html
var login_default = `<!DOCTYPE html>\r
<html lang="zh-CN" data-theme="light">\r
<head>\r
    <meta charset="UTF-8">\r
    <meta name="viewport" content="width=device-width, initial-scale=1.0">\r
    <title>登录 - HtmlBox</title>\r
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">\r
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>\r
    <link rel="stylesheet" href="/assets/theme.css">\r
    <script src="/assets/common.js"><\/script>\r
    <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">\r
    <style>\r
        .input-line {\r
            border: none;\r
            border-bottom: 2px solid var(--text-primary);\r
            background: transparent;\r
            outline: none;\r
        }\r
        .input-line:focus { border-color: var(--color-accent); }\r
        .btn-primary {\r
            background: var(--text-primary);\r
            color: var(--bg-primary);\r
            transition: all 0.3s ease;\r
        }\r
        .btn-primary:hover {\r
            background: var(--color-accent);\r
            transform: translateY(-2px);\r
            box-shadow: 0 10px 30px rgba(255, 107, 53, 0.3);\r
        }\r
        .fade-in { animation: fadeIn 0.6s ease forwards; }\r
        @keyframes fadeIn {\r
            from { opacity: 0; transform: translateY(20px); }\r
            to { opacity: 1; transform: translateY(0); }\r
        }\r
        .shake { animation: shake 0.5s ease; }\r
        @keyframes shake {\r
            0%, 100% { transform: translateX(0); }\r
            25% { transform: translateX(-10px); }\r
            75% { transform: translateX(10px); }\r
        }\r
        .password-wrapper { position: relative; }\r
        .password-toggle {\r
            position: absolute;\r
            right: 0;\r
            top: 50%;\r
            transform: translateY(-50%);\r
            cursor: pointer;\r
            padding: 8px;\r
            color: var(--text-secondary);\r
        }\r
        .password-toggle:hover { color: var(--text-primary); }\r
    </style>\r
</head>\r
<body class="min-h-screen flex items-center justify-center p-4">\r
    <div class="max-w-md w-full fade-in">\r
        <div class="text-center mb-12">\r
            <h1 class="text-5xl font-bold tracking-tight mb-2">HtmlBox</h1>\r
            <p class="font-mono text-sm" style="color: var(--text-secondary);">网页盒子</p>\r
        </div>\r
\r
        <form id="loginForm" class="space-y-8">\r
            <div class="password-wrapper">\r
                <input\r
                    type="password"\r
                    name="password"\r
                    id="passwordInput"\r
                    placeholder="输入管理密码"\r
                    class="input-line w-full py-3 text-xl text-center"\r
                    required\r
                >\r
                <button type="button" id="togglePassword" class="password-toggle">\r
                    <svg id="eyeIcon" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">\r
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>\r
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>\r
                    </svg>\r
                    <svg id="eyeOffIcon" class="w-5 h-5 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">\r
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>\r
                    </svg>\r
                </button>\r
            </div>\r
            <button\r
                type="submit"\r
                class="btn-primary w-full py-4 text-lg font-mono uppercase tracking-widest"\r
            >\r
                进入\r
            </button>\r
        </form>\r
\r
        <div id="error" class="hidden mt-6 text-center text-red-600 font-mono text-sm"></div>\r
\r
        <div class="mt-12 text-center">\r
            <a href="/" class="font-mono text-xs transition-colors" style="color: var(--text-secondary);">\r
                ← 返回首页\r
            </a>\r
        </div>\r
    </div>\r
\r
    <script>\r
        const passwordInput = document.getElementById('passwordInput');\r
        const toggleBtn = document.getElementById('togglePassword');\r
        const eyeIcon = document.getElementById('eyeIcon');\r
        const eyeOffIcon = document.getElementById('eyeOffIcon');\r
\r
        toggleBtn.addEventListener('click', function() {\r
            if (passwordInput.type === 'password') {\r
                passwordInput.type = 'text';\r
                eyeIcon.classList.add('hidden');\r
                eyeOffIcon.classList.remove('hidden');\r
            } else {\r
                passwordInput.type = 'password';\r
                eyeIcon.classList.remove('hidden');\r
                eyeOffIcon.classList.add('hidden');\r
            }\r
        });\r
\r
        const form = document.getElementById('loginForm');\r
        const errorEl = document.getElementById('error');\r
\r
        form.addEventListener('submit', async (e) => {\r
            e.preventDefault();\r
            const password = new FormData(form).get('password');\r
\r
            try {\r
                const res = await fetch('/api/auth/login', {\r
                    method: 'POST',\r
                    headers: { 'Content-Type': 'application/json' },\r
                    body: JSON.stringify({ password })\r
                });\r
\r
                const data = await res.json();\r
\r
                if (data.success) {\r
                    localStorage.setItem('token', data.token);\r
                    // 跳回来源页（?next=），仅接受站内相对路径防开放重定向\r
                    const next = new URLSearchParams(location.search).get('next');\r
                    window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/admin.html';\r
                } else {\r
                    errorEl.textContent = data.error;\r
                    errorEl.classList.remove('hidden');\r
                    form.classList.add('shake');\r
                    setTimeout(() => form.classList.remove('shake'), 500);\r
                }\r
            } catch (err) {\r
                errorEl.textContent = '网络错误';\r
                errorEl.classList.remove('hidden');\r
            }\r
        });\r
    <\/script>\r
</body>\r
</html>\r
`;

// src/pages/theme.css
var theme_default = `/* 三页共享主题：变量、基础排版、主题切换按钮 */
:root {
    --color-accent: #ff6b35;
    --color-release: #22c55e;
}

[data-theme="light"] {
    --bg-primary: #fafafa;
    --bg-card: #ffffff;
    --text-primary: #1a1a1a;
    --text-secondary: #6b7280;
    --border-color: #e5e5e5;
}

[data-theme="dark"] {
    --bg-primary: #0f0f0f;
    --bg-card: #1a1a1a;
    --text-primary: #f5f5f5;
    --text-secondary: #9ca3af;
    --border-color: #2d2d2d;
}

body {
    font-family: 'Noto Serif SC', serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    transition: background 0.3s ease, color 0.3s ease;
}

.font-mono { font-family: 'Space Mono', monospace; }

header, footer { border-color: var(--border-color) !important; }

.theme-toggle {
    cursor: pointer;
    padding: 8px;
    border-radius: 8px;
    transition: background 0.3s ease;
}

.theme-toggle:hover { background: var(--border-color); }
`;

// src/pages/common.js
var common_default = "// 三页共享：主题初始化/切换与 escapeHtml，在 <head> 中同步加载\n(function () {\n    const theme = localStorage.getItem('theme') || 'light';\n    document.documentElement.setAttribute('data-theme', theme);\n})();\n\nfunction updateIcon(theme) {\n    const sunIcon = document.getElementById('sunIcon');\n    const moonIcon = document.getElementById('moonIcon');\n    if (!sunIcon || !moonIcon) return;\n    if (theme === 'dark') {\n        sunIcon.classList.remove('hidden');\n        moonIcon.classList.add('hidden');\n    } else {\n        sunIcon.classList.add('hidden');\n        moonIcon.classList.remove('hidden');\n    }\n}\n\nfunction bindThemeToggle() {\n    const toggle = document.getElementById('themeToggle');\n    if (!toggle) return;\n\n    updateIcon(document.documentElement.getAttribute('data-theme'));\n\n    toggle.addEventListener('click', function () {\n        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';\n        document.documentElement.setAttribute('data-theme', next);\n        localStorage.setItem('theme', next);\n        updateIcon(next);\n    });\n}\n\nfunction escapeHtml(text) {\n    if (!text) return '';\n    const div = document.createElement('div');\n    div.textContent = text;\n    return div.innerHTML;\n}\n\nif (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', bindThemeToggle);\n} else {\n    bindThemeToggle();\n}\n";

// src/pages/favicon.svg
var favicon_default = '<?xml version="1.0" standalone="no"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg t="1773220346817" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5923" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200"><path d="M946.373 222.418C955.458 251.944 960 282.606 960 314.403s-6.246 62.459-18.738 91.985c-12.492 29.526-30.094 56.213-52.806 80.061-22.712 23.848-48.831 42.018-78.357 54.51-29.526 12.492-60.188 18.738-91.985 18.738s-62.459-6.814-91.985-20.441c-59.052 61.323-127.189 129.46-204.411 204.411-81.764 84.036-146.494 147.63-194.19 190.783-15.899 15.899-34.068 23.848-54.51 23.848-11.356 0-22.144-2.839-32.365-8.517s-19.873-13.06-28.958-22.144c-18.17-15.899-27.823-35.772-28.958-59.62-1.136-23.848 5.11-44.857 18.738-63.027a32423.043 32423.043 0 0 1 391.787-398.601c-11.356-29.526-17.034-60.755-17.034-93.688s6.246-64.73 18.738-95.392c12.492-30.662 30.094-57.349 52.806-80.061 22.712-22.712 48.831-40.314 78.357-52.806s59.62-18.738 90.281-18.738 60.755 4.542 90.281 13.627l10.221 51.103-132.866 136.273 78.357 78.357L895.27 212.198l51.103 10.22zM190.053 890.16c88.578-84.035 215.767-211.224 381.567-381.566-9.085-6.814-17.034-14.195-23.848-22.145-6.814-7.949-13.627-16.466-20.441-25.551-158.986 158.986-286.175 288.446-381.567 388.38-2.271 4.542-2.271 10.221 0 17.034 2.271 6.814 5.11 12.492 8.517 17.034s6.246 7.381 8.517 8.517c2.271 1.136 5.678 1.703 10.221 1.703h6.814c4.542 0.001 7.949-1.135 10.22-3.406z m708.624-596.198L782.844 409.795h-44.289l-119.24-119.24v-44.289l115.833-119.24h-17.034c-22.712 0-45.425 4.542-68.137 13.627-22.712 9.085-42.586 22.712-59.62 40.882s-30.094 38.611-39.179 61.323c-13.627 34.068-17.034 69.273-10.221 105.612 6.814 36.34 23.848 68.137 51.103 95.392 34.068 34.068 76.086 51.103 126.053 51.103s93.12-17.602 129.46-52.806c36.34-35.204 53.374-78.925 51.103-131.164v-17.033zM183.24 413.202L64 229.232l6.814-40.882 51.103-51.103 37.475-6.814 183.97 122.646 13.627 27.255-3.407 105.612 40.882 44.289-40.882 44.289-47.696-47.696h-95.392l-27.254-13.626z m-51.103-197.597l95.392 149.901h68.137v-71.544l-146.494-98.798-17.035 20.441z m671.148 630.266c2.271 2.271 3.975 5.11 5.11 8.517 1.136 3.407 1.703 7.382 1.703 11.924s-0.568 8.517-1.703 11.924c-1.136 3.407-2.839 6.814-5.11 10.221-2.271 3.407-6.246 6.246-11.924 8.517s-11.356 2.271-17.034 0c-5.678-2.271-10.788-5.678-15.331-10.221L561.399 682.342l-44.289 44.289 201.004 204.411c6.814 9.085 15.899 15.899 27.255 20.441 18.17 6.814 35.772 8.517 52.806 5.11 17.034-3.407 32.365-11.924 45.992-25.551 18.17-18.17 27.255-39.746 27.255-64.73 0-24.983-9.085-46.56-27.255-64.73L646.57 597.171l-44.289 44.289 201.004 204.411z" p-id="5924"></path></svg>';

// src/entries.js
var pages = {
  index: pages_default,
  admin: admin_default,
  login: login_default
};
var assets = {
  "/assets/theme.css": { body: theme_default, contentType: "text/css; charset=utf-8" },
  "/assets/common.js": { body: common_default, contentType: "text/javascript; charset=utf-8" },
  "/favicon.svg": { body: favicon_default, contentType: "image/svg+xml" }
};

// src/api/login.js
async function login(request, env) {
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
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const cookie = `session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1e3}${secure}`;
  return jsonResponse({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt
  }, 200, { "Set-Cookie": cookie });
}

// src/api/logout.js
async function logout(request, env) {
  const session = await verifySession(request, env);
  if (!session) {
    return jsonResponse({ error: "未登录或登录已过期" }, 401);
  }
  await revokeSession(env, getBearerToken(request));
  return jsonResponse({ success: true }, 200, {
    "Set-Cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  });
}
async function checkAuth(request, env) {
  const session = await verifySession(request, env);
  if (!session) {
    return jsonResponse({ authenticated: false }, 401);
  }
  return jsonResponse({ authenticated: true });
}

// src/api/sites.js
var CACHE_MAX_AGE = 86400;
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
async function validatePageNames(pageNames) {
  const seen = /* @__PURE__ */ new Set();
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
async function getSites(request, env, waitUntil) {
  const cacheKey = canonicalCacheKey(request);
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
  const allSites = (await Promise.all(list.map((slug) => getSite(env, slug)))).filter(Boolean);
  const sites = session ? allSites : allSites.filter((s) => s.visibility !== "private");
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
async function createSite(request, env) {
  const authError = await requireAuth(request, env);
  if (authError) return authError;
  const { error, body, slug } = await readSiteBody(request);
  if (error) return error;
  if (await getSite(env, slug)) {
    return jsonResponse({ error: "该 slug 已存在" }, 409);
  }
  const nameError = await validatePageNames((body.pages || []).map((p) => p.name ?? ""));
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
async function updateSite(request, env) {
  const authError = await requireAuth(request, env);
  if (authError) return authError;
  const { error, body, slug } = await readSiteBody(request);
  if (error) return error;
  const existing = await getSite(env, slug);
  if (!existing) {
    return jsonResponse({ error: "网站不存在" }, 404);
  }
  const nameError = await validatePageNames((body.pages || []).map((p) => p.name ?? ""));
  if (nameError) return nameError.error;
  const meta = validateMeta(body);
  if (meta.error) return meta.error;
  const site = buildSite(body, existing.createdAt, meta);
  await saveSite(env, site);
  await purgeApiSitesCache(request);
  await purgePageCache(request, site.slug, pageNamesOf(site));
  return jsonResponse({ success: true, site });
}
async function deleteSite(request, env) {
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
  await saveSiteList(env, list.filter((s) => s !== slug));
  await env.KV.delete(`site:${slug}`);
  await purgeApiSitesCache(request);
  await purgePageCache(request, slug, pageNamesOf(existing));
  return jsonResponse({ success: true });
}

// src/worker.js
var PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=3600";
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
function resolvePage(site, pageName) {
  const pages2 = site.pages || [];
  if (pages2.length === 0) {
    return pageName ? null : { html: site.html };
  }
  if (!pageName) {
    return null;
  }
  return pages2.find((p) => p.name === pageName) || null;
}
function renderSitePage(site, pageName) {
  const page = resolvePage(site, pageName);
  return page && page.html ? htmlResponse(page.html) : notFound();
}
function redirectToEntry(site, request) {
  const entry = (site.pages || [])[0];
  if (!entry || !entry.name) return null;
  const url = new URL(request.url);
  url.pathname = `/${site.slug}/${entry.name}`;
  return Response.redirect(url, 302);
}
async function respondWithSite(site, pageName, request, env, waitUntil) {
  if (site.visibility === "private") {
    if (!await verifySession(request, env)) {
      const url = new URL(request.url);
      const next = encodeURIComponent(url.pathname + url.search);
      return Response.redirect(new URL(`/login?next=${next}`, url.origin), 302);
    }
  }
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
      case "GET":
        return getSites(request, env, waitUntil);
      case "POST":
        return createSite(request, env);
      case "PUT":
        return updateSite(request, env);
      case "DELETE":
        return deleteSite(request, env);
    }
  }
  return null;
}
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    if (path === "/" || path === "/index" || path === "/index.html") return pageResponse(pages.index);
    if (path === "/admin" || path === "/admin.html") return pageResponse(pages.admin);
    if (path === "/login" || path === "/login.html") return pageResponse(pages.login);
    const asset = assets[path];
    if (asset) return assetResponse(asset);
    if (path.startsWith("/api/")) {
      const apiResponse = await handleApi(path, method, request, env, ctx.waitUntil.bind(ctx));
      return apiResponse || notFound();
    }
    const response = await siteResponse(path.slice(1), request, env, ctx.waitUntil.bind(ctx));
    return response || notFound();
  }
};
export {
  worker_default as default
};
