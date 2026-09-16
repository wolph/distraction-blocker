import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT: string = fileURLToPath(new URL('../../dist-pages/', import.meta.url));
const PREFIX: string = '/focus-lock/';
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

export interface PagesServer {
  url: string;
  close(): Promise<void>;
}

export async function startPagesServer(): Promise<PagesServer> {
  const server: Server = createServer((request, response): void => {
    const pathname: string = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (!pathname.startsWith(PREFIX)) {
      response.writeHead(404);
      response.end();
      return;
    }
    let relative: string = decodeURIComponent(pathname.slice(PREFIX.length));
    if (relative === '' || relative.endsWith('/')) relative = `${relative}index.html`;
    const file: string = path.resolve(ROOT, relative);
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve): void => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('pages server did not bind');
  return {
    url: `http://127.0.0.1:${String(address.port)}${PREFIX}`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject): void => {
        server.close((error?: Error): void => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
