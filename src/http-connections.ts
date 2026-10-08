import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/** Track sockets explicitly: Server.closeAllConnections is unavailable in Node 18.0.0. */
export function trackConnections(server: Server): () => void {
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () => { for (const socket of sockets) socket.destroy(); };
}
