const { loadConfig } = require("./config");
const { createApplication } = require("./app");

const config = loadConfig();
const application = createApplication(config);
const server = application.app.listen(config.port, () => {
  console.log(`HTTP server listening on port ${config.port}`);
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    application.close();
  });
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
