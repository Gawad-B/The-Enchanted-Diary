import { buildApp } from './app.js';
import { ConfigError, type Config } from './config.js';
import { loadConfigFromEnvironment } from './env-file.js';

const FORCE_EXIT_AFTER_MS = 10_000;

function readConfig(): Config {
  try {
    return loadConfigFromEnvironment();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const app = await buildApp(config);
if (config.sessionSecretGenerated) {
  app.log.warn('SESSION_SECRET is not set: using a random one, so sessions end when the server restarts');
}

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // If something keeps the event loop alive, do not hang forever.
  setTimeout(() => process.exit(1), FORCE_EXIT_AFTER_MS).unref();
  app.close().then(
    () => process.exit(0),
    (error: unknown) => {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    },
  );
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
});

try {
  await app.listen({ host: config.host, port: config.port });
  // Retention sweeps (now, then on a timer) and loading the embedding model start once the server is up.
  app.ingestion.startBackground();
} catch (error) {
  app.log.error({ err: error }, 'could not start the server');
  await app.close();
  process.exit(1);
}
