import { createServer } from 'node:http';

export const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=', 'base64');

// Shared by unit and desktop smoke checks. Never contact public image hosts.
export async function createImageFixture(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (handler) return handler(request, response);
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (['/image', '/image.png'].includes(pathname)) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(fixturePng);
    } else if (pathname === '/redirect.png') {
      response.writeHead(302, { Location: '/image' }); response.end();
    } else if (pathname === '/safe.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#268bd2"/><script>globalThis.compromised = true</script><image href="http://${request.headers.host}/nested.png" width="1" height="1"/></svg>`);
    } else if (pathname === '/invalid.png') {
      response.end('<html>Not an image</html>');
    } else {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
