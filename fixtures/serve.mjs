// Zero-dependency static server for the fixture site.
// Used by playwright.config.ts as the webServer command.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./site', import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Server-rendered pages for the behavior-mutation fixtures. The gate corrupts
// a value in transit via page.route, so the asserted value must arrive in the
// response - a client-rendered static file would not exercise the mode.
const html = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Profile</title></head><body>${body}</body></html>`;

createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://localhost').pathname);

  // Honest page: the plan the test asserts on is rendered into the body, so
  // corrupting it in transit changes what the page shows (verdict: killed).
  if (path === '/profile') {
    res.writeHead(200, { 'content-type': types['.html'] });
    res.end(html('<h1>Account profile</h1><span id="plan">Premium</span>'));
    return;
  }
  // Weak page: the plan lives in a response header the UI ignores; the visible
  // text is reconstructed client-side, so corrupting the response leaves the
  // assertion green even though the backend value is broken (verdict: weak).
  if (path === '/profile-stale') {
    res.writeHead(200, { 'content-type': types['.html'], 'x-plan': 'Premium' });
    res.end(
      html(
        '<h1>Account profile</h1><span id="plan"></span>' +
          "<script>document.getElementById('plan').textContent = ['Pre','mium'].join('');</script>",
      ),
    );
    return;
  }

  const file = join(root, path === '/' ? 'index.html' : path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`fixture site on http://127.0.0.1:${port}`);
});
