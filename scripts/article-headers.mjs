// GitHub Pages serves the article; this route adds the isolation headers
// required by the browser's multi-threaded model engine.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/watermark') {
      url.pathname = '/watermark/';
      return Response.redirect(url.href, 301);
    }
    const upstream = await fetch(request, { cf: { cacheTtl: 0 } });
    const response = new Response(upstream.body, upstream);
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Cache-Control', 'no-cache');
    return response;
  },
};
