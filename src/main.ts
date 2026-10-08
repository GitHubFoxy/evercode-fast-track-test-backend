import { loadConfig } from './config';
import { createApplication } from './app';
import { trackConnections } from './http-connections';

const config = loadConfig();
const application = createApplication(config);
const server = application.app.listen(config.port, () => {
  console.log(`HTTP server listening on port ${config.port}`);
});
const closeConnections = trackConnections(server);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  // Abort provider I/O first: server.close alone would wait for its timeout.
  const closedApplication = Promise.resolve(application.close());
  const closedServer = new Promise<void>(resolve => server.close(() => resolve()));
  closeConnections();
  const deadline = setTimeout(() => {
    closeConnections();
    // The OS closes remaining descriptors if an unexpected callback refuses to finish.
    process.exit(1);
  }, config.shutdownTimeoutMs);
  Promise.all([closedApplication, closedServer]).then(() => clearTimeout(deadline), () => {
    closeConnections(); clearTimeout(deadline); process.exitCode = 1;
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
