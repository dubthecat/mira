// Minimal static file server for the racer directory. Used both for playing
// in a normal browser (`npm run dev`) and by the headless recorder — ES module
// imports don't work over file://, and this keeps us free of build tooling.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
};

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(ROOT, rel));
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

// standalone: `node src/record/serve.js [port]`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = parseInt(process.argv[2] || '8712', 10);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`racer served at http://127.0.0.1:${port}/?seed=1`);
  });
}
