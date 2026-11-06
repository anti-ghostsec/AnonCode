/**
 * JSON-RPC message framing for the Language Server Protocol.
 *
 * LSP frames each JSON message with a `Content-Length` header (like HTTP):
 *
 *   Content-Length: 123\r\n
 *   \r\n
 *   {json...}
 *
 * `encodeMessage` produces that framing; `MessageReader` accumulates raw bytes
 * from a stream and emits complete parsed messages, handling split reads and
 * multiple messages per chunk.
 */

export function encodeMessage(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, json]);
}

export class MessageReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer, onMessage: (msg: unknown) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // malformed header; drop up to the separator and resync
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return; // body not fully arrived yet
      const body = this.buf.subarray(start, start + len);
      this.buf = this.buf.subarray(start + len);
      try {
        onMessage(JSON.parse(body.toString("utf8")));
      } catch {
        /* ignore a malformed body */
      }
    }
  }
}
