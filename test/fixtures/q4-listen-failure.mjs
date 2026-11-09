// Explicit asynchronous bind-error injection for qualification child-process tests only.
import { Server } from 'node:http';
Server.prototype.listen = function () {
  queueMicrotask(() => this.emit('error', Object.assign(new Error('Synthetic bind failure'), { code: 'EADDRINUSE' })));
  return this;
};
