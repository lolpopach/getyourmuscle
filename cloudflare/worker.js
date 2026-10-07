// Edge entry point: static app from Workers Static Assets, /api/* proxied to the Node API
// (Fly.io). Keeping both behind one hostname is what lets passkeys (WebAuthn) work.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const target = new URL(url.pathname + url.search, env.API_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-for');
    headers.set('x-opengym-client-ip', request.headers.get('cf-connecting-ip') || '');
    if (env.PROXY_SECRET) headers.set('x-opengym-proxy-secret', env.PROXY_SECRET);

    // Body is streamed through, so media uploads are not buffered in the Worker.
    return fetch(new Request(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    }));
  },
};
