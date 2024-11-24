import { createServer, type Server } from 'node:http';

export interface TestServer {
  port: number;
  close(): Promise<void>;
}

const PAGES: Readonly<Record<string, string>> = {
  '/plain.html': `<!doctype html>
<html><head><title>Plain test page</title></head>
<body><h1 id="marker">plain page</h1><input id="keep" /></body></html>`,
  '/spa.html': `<!doctype html>
<html><head><title>SPA test page</title></head>
<body>
<h1 id="marker">spa page</h1>
<button id="navigate" type="button">Open shorts</button>
<script>
document.querySelector('#navigate').addEventListener('click', () => {
  history.pushState({}, '', '/shorts/feed');
  document.querySelector('#marker').textContent = 'shorts feed';
});
</script>
</body></html>`,
  '/media.html': `<!doctype html>
<html><head><title>Media test page</title></head>
<body>
<h1 id="marker">media page</h1>
<audio id="tone" autoplay loop src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="></audio>
</body></html>`,
};

export async function startServer(): Promise<TestServer> {
  const server: Server = createServer((request, response): void => {
    const pathname: string = new URL(request.url ?? '/', 'http://blocked.example').pathname;
    const body: string | undefined = PAGES[pathname];
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }

    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(body);
  });

  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', (): void => {
      server.off('error', reject);
      resolve();
    });
  });

  const address: ReturnType<Server['address']> = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }

  return {
    port: address.port,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject): void => {
        server.close((error?: Error): void => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    },
  };
}
