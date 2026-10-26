// Edge entry point: the built app from Workers Static Assets, and /api/* answered by the API in
// the GymStore Durable Object (cloudflare/api.js) — one hostname, which passkeys need.
//
// With API_MODE=proxy and API_ORIGIN set, /api/* is passed to an external API instead (the Node
// server in api/, e.g. on Fly.io), with the visitor's address for its sign-in throttle.
export { GymStore } from './store.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (env.API_MODE === 'proxy' && env.API_ORIGIN) {
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
    }

    const stub = env.STORE.get(env.STORE.idFromName('main'));
    return stub.fetch(request);
  },
};
