import { createApp } from './app.js';
const app = createApp();
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => console.log(`Mawaid listening on port ${process.env.PORT || 3000}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => { app.locals.db.close(); process.exit(0); }));
