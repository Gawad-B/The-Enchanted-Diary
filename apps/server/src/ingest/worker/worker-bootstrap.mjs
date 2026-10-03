// Entry of an ingestion worker thread when the server runs from TypeScript sources (development, tests): the
// thread registers tsx and then loads worker.ts. A built server (dist/) has worker.js next to this file's
// sources and starts that directly (see entry.ts), so tsx is not needed in production.
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
