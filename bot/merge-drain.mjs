import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// The marker is untrusted operator input. Never follow its final symlink or
// block opening a FIFO; only a bounded regular-file read can authorize an ACK.
export async function readSelectionDrainRequest(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { request_id: null, error: error.code === 'ELOOP' ? 'invalid_request' : 'unavailable' };
  }

  let result;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128) {
      result = { request_id: null, error: 'invalid_request' };
    } else {
      // Read one extra byte to detect growth after stat without an unbounded read.
      const buffer = Buffer.alloc(129);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const match = length <= 128 && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/u.exec(buffer.toString('utf8', 0, length));
      result = match ? { request_id: match[1], error: null } : { request_id: null, error: 'invalid_request' };
    }
  } catch {
    result = { request_id: null, error: 'unavailable' };
  } finally {
    try {
      await file.close();
    } catch {
      result = { request_id: null, error: 'unavailable' };
    }
  }
  return result;
}
