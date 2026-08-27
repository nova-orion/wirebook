// Regenerates the screenshots in the README.
//
//   node tools/screenshots.mjs
//
// Shot against inventory.demo.yaml, never against a real inventory: these are
// committed to a public repo and a real one carries hostnames, MACs and
// management URLs. Scripted rather than hand-captured so they can be redone
// after a UI change instead of quietly going stale.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.yaml': 'text/yaml',
};
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

const browser = await chromium.launch();
const page = await (await browser.newContext({
  viewport: { width: 1380, height: 860 }, deviceScaleFactor: 2,
})).newPage();
await page.addInitScript(() => { delete window.showOpenFilePicker; });
await page.goto(base + 'index.html');
await page.waitForSelector('#menubar .tab');
await page.evaluate(y => ingest(y, 'inventory.demo.yaml'),
  fs.readFileSync(path.join(root, 'inventory.demo.yaml'), 'utf8'));

const shot = async (name, prepare) => {
  await page.evaluate(prepare);
  // long enough for the toast to fade, or every shot has "loaded 16 nodes"
  // sitting over the footer
  await page.waitForTimeout(1900);
  await page.screenshot({ path: path.join(outDir, name + '.png') });
  console.log('  wrote docs/screenshots/' + name + '.png');
};

await shot('graph', () => {
  S.sel = { kind: 'view', id: 'graph' };
  render();
  // trace a run so the screenshot shows what the view is actually for
  const l = S.inv.links.find(x => x.a === 'power/strip:inlet' || x.b === 'power/strip:inlet');
  if (l) { S.gtrace = { a: l.a, b: l.b }; render(); }
  // scale the whole diagram into the frame, so the shot shows all of it
  const fitBtn = [...document.querySelectorAll('#view button')].find(x => x.textContent === 'fit');
  if (fitBtn) fitBtn.click();
});

await shot('free-ports', () => { S.gtrace = null; S.sel = { kind: 'view', id: 'free' }; render(); });

await shot('tree', () => { S.sel = { kind: 'view', id: 'tree' }; render(); });

await shot('node-editor', () => {
  S.sel = { kind: 'node', id: 'compute/server' };
  S.openPorts = new Set(['compute/server:eth0']);
  S.lastView = 'tree';
  render();
});

await browser.close();
srv.close();
console.log('done');
