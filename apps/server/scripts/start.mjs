// `npm start`: runs the compiled server. A built server is a production server, so NODE_ENV defaults to
// production here (an explicit NODE_ENV still wins). Production never loads pino-pretty, a dev dependency.
process.env.NODE_ENV ??= 'production';
await import('../dist/main.js');
