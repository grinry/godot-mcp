import {
  isJSONRPCRequest,
  type Transport,
  UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/** v2's pinned stdio connection does not recheck revisions on subsequent calls. */
export function versionedStdio(): Transport {
  const wire = new StdioServerTransport();
  const transport: Transport = {
    start: () => wire.start(),
    close: () => wire.close(),
    send: (message) => wire.send(message),
  };
  wire.onclose = () => transport.onclose?.();
  wire.onerror = (error) => transport.onerror?.(error);
  wire.onmessage = (message) => {
    if (isJSONRPCRequest(message)) {
      const claimed = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
      if (typeof claimed === 'string' && claimed >= '2026-07-28' && claimed !== '2026-07-28') {
        const error = new UnsupportedProtocolVersionError({
          supported: ['2026-07-28'],
          requested: claimed,
        });
        void wire
          .send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: error.code, message: error.message, data: error.data },
          })
          .catch((error: Error) => transport.onerror?.(error));
        return;
      }
    }
    transport.onmessage?.(message);
  };
  return transport;
}
