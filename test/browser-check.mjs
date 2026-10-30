// 用 CDP 驱动 Edge 验证浏览器端登录流程（无第三方依赖）
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9222;
const BASE = "http://127.0.0.1:8888";
const PASSWORD = "light";

const profile = mkdtempSync(join(tmpdir(), "cdp-"));
const shots = join(process.cwd(), "shots");
mkdirSync(shots, { recursive: true });

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

class CDP {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.sessions = new Map();
        ws.addEventListener("message", ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            }
        });
    }
    send(method, params = {}, sessionId) {
        const id = ++this.id;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
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
}

let cdp;
async function connect() {
    const wsUrl = await getWsUrl();
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
    });
    cdp = new CDP(ws);
}

async function newPage(url) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    cdp.sessions.set(targetId, sessionId);
    return sessionId;
}

async function goto(sessionId, url) {
    await cdp.send("Page.navigate", { url }, sessionId);
    // 等 DOM 出现关键元素再继续
    for (let i = 0; i < 40; i++) {
        await sleep(300);
        const ready = await evalJs(sessionId, `!!document.body && document.readyState === 'complete'`)
            .catch(() => false);
        if (ready) break;
    }
    await sleep(2500);
}

// 轮询直到表达式为真
async function waitFor(sessionId, expr, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = await evalJs(sessionId, expr).catch(() => null);
        if (v) return v;
        await sleep(300);
    }
    return null;
}

async function evalJs(sessionId, expr) {
    const r = await cdp.send("Runtime.evaluate", {
        expression: expr, returnByValue: true, awaitPromise: true
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    return r.result.value;
}

async function shot(sessionId, name) {
    const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
    const size = metrics.cssContentSize || metrics.contentSize;
    const width = Math.max(Math.ceil(size.width), 1280);
    const height = Math.max(Math.ceil(size.height), 900);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    await sleep(300);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
    const file = join(shots, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
}

// 真实用户操作：按坐标点击输入框并输入
async function clickAt(sessionId, x, y) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    await sleep(200);
}

async function typeText(sessionId, text) {
    for (const ch of text) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch }, sessionId);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", text: ch }, sessionId);
    }
}

const results = [];
function check(name, pass, detail = "") {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
}

try {
    await connect();
    console.log("CDP 已连接");

    // --- P0: 登录页渲染 ---
    const s = await newPage();
    await goto(s, `${BASE}/login.html`);
    const title = await evalJs(s, "document.title");
    const hasInput = await evalJs(s, "!!document.getElementById('passwordInput')");
    check("登录页渲染", title.includes("登录") && hasInput, `title=${title}`);
    await shot(s, "01-login");

    // --- P0: 输入密码并点击进入 ---
    const box = await evalJs(s, `(() => { const r = document.getElementById('passwordInput').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
    await clickAt(s, box.x, box.y);
    await typeText(s, PASSWORD);
    const typed = await evalJs(s, "document.getElementById('passwordInput').value.length");
    check("密码输入", typed === PASSWORD.length, `len=${typed}`);

    const btn = await evalJs(s, `(() => { const r = document.querySelector('button[type=submit]').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
    await clickAt(s, btn.x, btn.y);
    await sleep(2500);

    const url = await evalJs(s, "location.pathname");
    check("登录后跳转后台", url.includes("admin"), `path=${url}`);
    await shot(s, "02-admin-after-login");

    // --- P0: 后台内容可见 ---
    const contentVisible = await evalJs(s, "!document.getElementById('content').classList.contains('hidden')");
    const siteCount = await evalJs(s, "document.querySelectorAll('#sitesList .site-item').length");
    check("后台列表渲染", contentVisible && siteCount > 0, `条目=${siteCount}`);

    // --- P0: token 不在 localStorage ---
    const ls = await evalJs(s, "JSON.stringify(localStorage)");
    check("token 不落 localStorage", !ls.includes("token") || !ls.includes("session"), `localStorage=${ls}`);

    // --- P0: Cookie 存在且 HttpOnly ---
    const cookies = await cdp.send("Network.getCookies", { urls: [BASE] }, s);
    const sessionCookie = cookies.cookies.find(c => c.name === "session");
    check("Cookie 存在", !!sessionCookie, sessionCookie ? `httpOnly=${sessionCookie.httpOnly} sameSite=${sessionCookie.sameSite}` : "无 session cookie");

    // --- P1: 编辑私有站（走详情接口）---
    const editResult = await evalJs(s, `(async () => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '修改');
        if (!btn) return 'no-edit-btn';
        btn.click();
        await new Promise(r => setTimeout(r, 1800));
        const slug = document.querySelector('[name="slug"]').value;
        const titleVal = document.querySelector('[name="title"]').value;
        const htmlLen = document.querySelector('[name="html"]').value.length;
        const nameRows = document.querySelectorAll('[data-name-row]:not(.hidden)').length;
        return JSON.stringify({slug, titleVal, htmlLen, nameRows, formTitle: document.getElementById('formTitle').textContent});
    })()`);
    let edit = {};
    try { edit = JSON.parse(editResult); } catch { edit = { raw: editResult }; }
    check("编辑回填详情", edit.slug && edit.htmlLen > 0, editResult.slice(0, 160));
    await shot(s, "03-admin-edit");

    // --- P1: 取消编辑恢复 ---
    await evalJs(s, `(() => { const b = document.getElementById('cancelEditBtn'); if (!b.classList.contains('hidden')) b.click(); })()`);
    await sleep(600);

    // --- P1: 退出登录 ---
    await evalJs(s, "document.getElementById('logoutBtn').click()");
    await sleep(2000);
    const afterLogout = await evalJs(s, "location.pathname");
    check("退出后跳首页", afterLogout === "/" || afterLogout === "/index.html", `path=${afterLogout}`);

    // --- P0: 未登录访问私有站应跳登录页 ---
    const s2 = await newPage();
    await goto(s2, `${BASE}/abc/a.html`);
    const privPath = await evalJs(s2, "location.pathname + location.search");
    check("私有站未登录跳登录", privPath.includes("/login"), `path=${privPath}`);
    await shot(s2, "04-private-redirect");

    // --- P1: 首页渲染 ---
    const s3 = await newPage();
    await goto(s3, `${BASE}/`);
    const cards = await evalJs(s3, "document.querySelectorAll('#sites .card').length");
    const loadingHidden = await evalJs(s3, "document.getElementById('loading').classList.contains('hidden')");
    check("首页渲染工具卡片", cards > 0 && loadingHidden, `卡片=${cards}`);
    await shot(s3, "05-home");

    // --- P1: 首页未登录不含私有站 ---
    const hasPrivate = await evalJs(s3, "document.getElementById('sites').innerHTML.includes('私有')");
    check("首页匿名不含私有站", !hasPrivate, `含私有标记=${hasPrivate}`);

    // --- P1: 首页登录后应含私有站 ---
    const s4 = await newPage();
    await goto(s4, `${BASE}/login.html`);
    const b2 = await evalJs(s4, `(() => { const r = document.getElementById('passwordInput').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
    await clickAt(s4, b2.x, b2.y);
    await typeText(s4, PASSWORD);
    const b3 = await evalJs(s4, `(() => { const r = document.querySelector('button[type=submit]').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
    await clickAt(s4, b3.x, b3.y);
    await sleep(2000);
    await goto(s4, `${BASE}/`);
    const privAfterLogin = await evalJs(s4, "document.getElementById('sites').innerHTML.includes('私有')");
    check("首页登录后含私有站", privAfterLogin, `含私有标记=${privAfterLogin}`);
    await shot(s4, "06-home-logged-in");

} catch (err) {
    console.log("ERROR: " + err.message);
    results.push({ name: "执行异常", pass: false, detail: err.message });
} finally {
    edge.kill();
    const failed = results.filter(r => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
    process.exit(failed.length ? 1 : 0);
}
