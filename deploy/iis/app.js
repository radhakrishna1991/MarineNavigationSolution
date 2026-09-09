/**
 * iisnode entry point.
 *
 * iisnode launches this file rather than `backend/src/index.js` for one reason:
 * the URL Rewrite rules need a stable path at the root of the application to
 * name, independent of where the backend source sits beneath it. Everything
 * else - configuration, database, sockets - is the ordinary startup path.
 *
 * `backend/` keeps its depth in the published tree because the configuration
 * loader resolves the application root three levels up from `src/config`, and
 * that is where it expects to find `.env` and `data/`.
 *
 * Startup failures are written to stderr, which iisnode captures into
 * `iisnode\*.txt`. That is the only place they are visible: IIS reports a bare
 * 500, and the platform's own logger never gets the chance to open.
 */

process.on('unhandledRejection', (reason) => {
  console.error('[iisnode] unhandled rejection during startup:', reason);
});

import('./backend/src/index.js').catch((err) => {
  console.error('[iisnode] failed to load the platform:', err && err.stack ? err.stack : err);
  process.exit(1);
});
