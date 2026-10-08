// 构建入口：把 src/ 打成单个 _worker.js
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const outfile = fileURLToPath(new URL("./_worker.js", import.meta.url));

// src/pages/ 下全是给浏览器/页面用的资源，必须原样内嵌为文本；
// 而同目录外（src/common.js、src/api/*.js）是后端模块，要走正常打包
const embedPlugin = {
    name: 'embed-pages',
    setup(b) {
        b.onLoad({ filter: /src[\\/]pages[\\/]/ }, async (args) => ({
            loader: 'text',
            contents: await readFile(args.path, 'utf8')
        }));
    }
};

await build({
    entryPoints: ['src/worker.js'],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile,
    plugins: [embedPlugin],
    legalComments: 'none'
});

console.log('built _worker.js');
