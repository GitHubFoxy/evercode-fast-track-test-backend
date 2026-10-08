const http = require('node:http');
const { trackConnections } = require('../dist/http-connections');

exports.createServer = (...args) => {
  const server = http.createServer(...args);
  server.closeAllConnections = trackConnections(server);
  return server;
};
