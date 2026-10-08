# HtmlBox

网页盒子：粘贴一段 HTML，发布成一个独立网页。

## 功能

- **一键发布**：后台粘贴 HTML代码，设定访问路径，立即上线
- **多页沙盒**：一个路径下可放多页 HTML（如 `a.html`、`b.html`），首个页面是入口，访问 `/my-tool` 自动进入它，其余用 `/my-tool/b.html` 直达
- **公开或私有**：站点可设为私有，未登录访客看不到列表也进不去页面（自动跳登录），整站所有页随主页
- **标签分类**：给网页打标签，首页按标签筛选
- **明暗主题**：手动切换，刷新后保持
- **后台管理**：已发网页可修改、可删除，改完立即生效
- **密码登录**：单管理员密码，会话保持 7 天

## 部署

- 代码构建为单个 `_worker.js`，部署只需这一个文件：
- 复制代码，创建 worker 粘贴代码部署
- 或在 Cloudflare Pages 后台直接上传 `_worker.js`（Direct Upload）
- 设置变量和密钥，名称为`ADMIN_PASSWORD`，值为密码
- 并绑定 Workers KV (KV 命名空间)，键名为`KV`,数据库选择你创建的如`HtmlBox`，绑定并部署，Pages 需要重新上传部署

## 用法

- 在管理后台填写路径和标题，粘贴 HTML 发布，访客便可通过公开链接访问。
- 每个路径都是一个独立的 HTML 沙盒，支持放置多个页面，每页可单独命名（如 a.html）。
- 首个页面作为入口，访问主路径会自动跳转进去，其他页面可通过 /主路径/b.html 直接访问。
- 数据存储在 Cloudflare KV，无需数据库，新增网页无需改动_worker.js代码。

## 目录结构与路由表

```
build.mjs                 # esbuild 入口：src/ -> _worker.js
src/
├── worker.js             # 唯一路由决策点：fetch handler
├── common.js             # 后端唯一共享模块（KV/缓存/鉴权工具）
├── api/login.js          # POST /api/auth/login
├── api/logout.js         # GET 查登录态 / POST 登出
├── api/sites.js          # GET/POST/PUT/DELETE /api/sites
└── pages/                # 构建期内嵌为文本字符串（见警告）
    ├── index.html admin.html login.html
    ├── theme.css         # 三页共享主题变量（路由 /assets/theme.css）
    ├── common.js         # 前端共享 JS（路由 /assets/common.js）
    └── favicon.svg       # 路由 /favicon.svg
_worker.js                # 构建产物：部署只需这一个文件
```

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars         # 填入管理密码
cp wrangler.toml.example wrangler.toml # 填入 KV namespace 的 id
npm run dev                            # 启动本地服务，8888 端口
```

- 首页：<http://localhost:8888>
- 管理后台：<http://localhost:8888/admin>（未登录会跳转登录页）
