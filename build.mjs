// 把 core.js 與 app.js 塞進 shell.html，產生 index.html：node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const r = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const html = r('shell.html').replace('/*__CORE__*/', () => r('core.js')).replace('/*__APP__*/', () => r('app.js'));
writeFileSync(new URL('index.html', import.meta.url), html);
console.log('index.html', html.length);
