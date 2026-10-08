// 构建期内嵌资源入口：src/pages/ 下的文件由 build.mjs 以 text loader 读成字符串
// 新增页面/静态资源只需在这里登记一行，worker.js 不需要关心文件路径
import indexHtml from "./pages/index.html";
import adminHtml from "./pages/admin.html";
import loginHtml from "./pages/login.html";
import themeCss from "./pages/theme.css";
import commonJs from "./pages/common.js";
import faviconSvg from "./pages/favicon.svg";

export const pages = {
    index: indexHtml,
    admin: adminHtml,
    login: loginHtml
};

export const assets = {
    "/assets/theme.css": { body: themeCss, contentType: "text/css; charset=utf-8" },
    "/assets/common.js": { body: commonJs, contentType: "text/javascript; charset=utf-8" },
    "/favicon.svg": { body: faviconSvg, contentType: "image/svg+xml" }
};
