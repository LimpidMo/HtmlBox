// 新增功能回归：首页搜索/排序/计数、后台条目上下移与入口徽标（CDP 驱动 Edge）
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9223;
const BASE = "http://127.0.0.1:8888";
const PASSWORD = "light";

const profile = mkdtempSync(join(tmpdir(), "cdp-ux-"));
const edge = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--proxy-server=http://192.168.31.40:7890",
    "--proxy-bypass-list=127.0.0.1;localhost",
    "about:blank"
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
            const json = await res.json();
            if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
        } catch {}
        await sleep(250);
    }
    throw new Error("CDP 未就绪");
}

let cdp;
async function connect() {
    const ws = new WebSocket(await getWsUrl());
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
    });
    cdp = {
        ws,
        id: 0,
        pending: new Map(),
        send(method, params = {}, sessionId) {
            const id = ++this.id;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
            return new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                setTimeout(() => {
                    if (this.pending.has(id)) {
                        this.pending.delete(id);
                        reject(new Error(`${method} 超时`));
                    }
                }, 30000);
            });
        }
    };
    ws.addEventListener("message", ev => {
        const msg = JSON.parse(ev.data);
        const p = msg.id && cdp.pending.get(msg.id);
        if (p) {
            cdp.pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
    });
}

async function newPage() {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    return sessionId;
}

async function evalJs(sessionId, expr) {
    const r = await cdp.send("Runtime.evaluate", {
        expression: expr, returnByValue: true, awaitPromise: true
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
}

async function goto(sessionId, url) {
    await cdp.send("Page.navigate", { url }, sessionId);
    for (let i = 0; i < 40; i++) {
        await sleep(300);
        if (await evalJs(sessionId, `document.readyState === 'complete'`).catch(() => false)) break;
    }
    await sleep(2500);
}

const results = [];
function check(name, pass, detail = "") {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
}

try {
    await connect();

    // --- 首页：工具栏、计数、搜索、排序 ---
    const s = await newPage();
    await goto(s, `${BASE}/`);
    const toolbarVisible = await evalJs(s, `!document.getElementById('toolbar').classList.contains('hidden')`);
    const countText = await evalJs(s, `document.getElementById('resultCount').textContent`);
    check("首页工具栏与计数", toolbarVisible && /\d+ \/ \d+/.test(countText), `count=${countText}`);

    const total = await evalJs(s, `document.querySelectorAll('#sites .card').length`);
    await evalJs(s, `(() => { const el = document.getElementById('searchInput'); el.value = 'pomodoro'; el.dispatchEvent(new Event('input')); })()`);
    await sleep(300);
    const afterSearch = await evalJs(s, `document.querySelectorAll('#sites .card').length`);
    const searchCount = await evalJs(s, `document.getElementById('resultCount').textContent`);
    check("搜索过滤生效", afterSearch > 0 && afterSearch < total, `${total} -> ${afterSearch}, count=${searchCount}`);

    await evalJs(s, `(() => { const el = document.getElementById('searchInput'); el.value = 'zzz-not-exist'; el.dispatchEvent(new Event('input')); })()`);
    await sleep(300);
    const emptyText = await evalJs(s, `document.getElementById('empty').classList.contains('hidden') ? '' : document.querySelector('#empty p').textContent`);
    check("搜索无结果提示", emptyText === '没有匹配的网页', `text=${emptyText}`);

    await evalJs(s, `(() => { const el = document.getElementById('searchInput'); el.value = ''; el.dispatchEvent(new Event('input')); })()`);
    await sleep(300);
    await evalJs(s, `(() => { const el = document.getElementById('sortSelect'); el.value = 'title'; el.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    const titles = await evalJs(s, `Array.from(document.querySelectorAll('#sites .card h2')).map(h => h.textContent)`);
    const sorted = [...titles].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    check("标题排序生效", JSON.stringify(titles) === JSON.stringify(sorted), titles.join(','));

    const metaText = await evalJs(s, `(() => { const c = document.querySelector('#sites .card'); return c ? c.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
    check("卡片含页数/更新时间", /页/.test(metaText) || /更新/.test(metaText), metaText.slice(0, 80));

    // --- 后台：登录 → 编辑多页站 → 入口徽标 → 下移 → 取消（不写库） ---
    const a = await newPage();
    await goto(a, `${BASE}/login.html`);
    await evalJs(a, `(() => { document.getElementById('passwordInput').value = '${PASSWORD}'; })()`);
    await evalJs(a, `document.querySelector('button[type=submit]').click()`);
    await sleep(2500);
    await goto(a, `${BASE}/admin.html`);

    const badgeInit = await evalJs(a, `(async () => {
        const btn = Array.from(document.querySelectorAll('#sitesList button')).find(b => b.textContent.trim() === '修改');
        if (!btn) return 'no-edit';
        btn.click();
        await new Promise(r => setTimeout(r, 1800));
        const entries = document.querySelectorAll('.page-entry');
        const visible = Array.from(document.querySelectorAll('[data-entry-badge]')).filter(b => !b.classList.contains('hidden')).length;
        const totalSize = document.getElementById('totalSize').textContent;
        return JSON.stringify({ entries: entries.length, visible, totalSize });
    })()`);
    let init = {};
    try { init = JSON.parse(badgeInit); } catch { init = { raw: badgeInit }; }
    check("编辑态条目与体积提示", init.entries > 0 && /总计/.test(init.totalSize || ''), badgeInit.slice(0, 120));

    const moved = await evalJs(a, `(() => {
        const entries = Array.from(document.querySelectorAll('.page-entry'));
        if (entries.length < 2) return 'only-one';
        entries[0].querySelector('[data-action="down"]').click();
        const visible = Array.from(document.querySelectorAll('[data-entry-badge]')).filter(b => !b.classList.contains('hidden'));
        const owner = visible.length ? Array.from(document.querySelectorAll('.page-entry')).indexOf(visible[0].closest('.page-entry')) : -1;
        const upDisabledFirst = document.querySelector('.page-entry [data-action="up"]').disabled;
        return JSON.stringify({ owner, upDisabledFirst });
    })()`);
    let mv = {};
    try { mv = JSON.parse(moved); } catch { mv = { raw: moved }; }
    check("下移后入口徽标转移到新首条", mv.owner === 0 && mv.upDisabledFirst === true, moved);

    // 文件导入：构造 File 写入隐藏 input，验证 textarea 被填充
    const imported = await evalJs(a, `(async () => {
        const input = document.querySelector('[data-file]');
        const dt = new DataTransfer();
        dt.items.add(new File(['<h1>imported</h1>'], 'x.html', { type: 'text/html' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 800));
        const entry = input.closest('.page-entry');
        return JSON.stringify({ value: entry.querySelector('[name="html"]').value, size: entry.querySelector('[data-size]').textContent });
    })()`);
    let imp = {};
    try { imp = JSON.parse(imported); } catch { imp = { raw: imported }; }
    check("文件导入填充 textarea", imp.value === '<h1>imported</h1>', imported);

    // 导出接口在页面上下文可用（含 html 字段）
    const exported = await evalJs(a, `(async () => {
        const res = await fetch('/api/sites/export', { credentials: 'same-origin' });
        const data = await res.json();
        return JSON.stringify({ ok: res.ok, count: data.sites.length, hasHtml: data.sites.every(s => typeof s.html === 'string') });
    })()`);
    let exp = {};
    try { exp = JSON.parse(exported); } catch { exp = { raw: exported }; }
    check("导出备份含全站 html", exp.ok === true && exp.count > 0 && exp.hasHtml === true, exported);

    // 取消编辑，不提交任何数据变更
    await evalJs(a, `(() => { const b = document.getElementById('cancelEditBtn'); if (b && !b.classList.contains('hidden')) b.click(); })()`);
    await sleep(600);

} catch (err) {
    console.log("ERROR: " + err.message);
    results.push({ name: "执行异常", pass: false, detail: err.message });
} finally {
    edge.kill();
    const failed = results.filter(r => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
    process.exit(failed.length ? 1 : 0);
}
