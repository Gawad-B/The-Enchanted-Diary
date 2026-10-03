import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Where the browser half of `@vercel/blob` (2.8.0) sends EVERY upload request: `https://vercel.com/api/blob` (the single
 * PUT `/?pathname=`, and the multipart `POST /mpu?pathname=` calls). It is not the store's own host
 * (`*.blob.vercel-storage.com` is only where stored blobs are read, which this server does with the token), so that host is
 * deliberately not allowed. A CSP source that ends in `/` matches by path prefix, which covers both calls.
 */
export const BLOB_UPLOAD_ORIGIN = 'https://vercel.com/api/blob/';

/**
 * Content-Security-Policy for the SPA in production. No inline scripts, no remote origins: fonts, textures
 * and models are bundled. `blob:` is for pdf.js and page-texture workers/images, `wasm-unsafe-eval` for
 * WebAssembly (pdf.js), `unsafe-inline` styles for React style props and the scene's measured layout.
 * With `blob` (the files go straight from the browser to a Vercel Blob store) `connect-src` also allows the endpoint the Blob
 * client uploads through, and nothing else.
 */
export function contentSecurityPolicy(options: { blob?: boolean } = {}): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    options.blob === true ? `connect-src 'self' ${BLOB_UPLOAD_ORIGIN}` : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The policy when files go to this server (development, tests, a server of your own). */
export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/** Sets the security headers on a reply. A reply that already has its own CSP (the PDF file) keeps it. */
export function applySecurityHeaders(
  reply: FastifyReply,
  options: { csp: boolean; /** The policy to send; default: CONTENT_SECURITY_POLICY. */ policy?: string },
): void {
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('Referrer-Policy', 'same-origin');
  void reply.header('X-Frame-Options', 'DENY');
  if (options.csp && !reply.hasHeader('content-security-policy')) {
    void reply.header('Content-Security-Policy', options.policy ?? CONTENT_SECURITY_POLICY);
  }
}

/** Adds the security headers to every response that goes through a route (or the 404 handler). */
export function registerSecurityHeaders(
  app: FastifyInstance,
  options: { csp: boolean; policy?: string },
): void {
  app.addHook('onSend', (_request, reply, _payload, done) => {
    applySecurityHeaders(reply, options);
    done();
  });
}
