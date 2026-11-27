/**
 * Reading a request's body without holding more of it than the caller
 * takes: talk proposals (proposals.ts) and searches (search/route.ts).
 * It imports nothing, so a module that loads lazily can take it alone.
 */

/**
 * A request's body, read only up to `limit` bytes: undefined past it,
 * however long the body says it is, so nothing larger is ever held. Read
 * off even when it is refused, so the connection it came on stays usable.
 */
export async function boundedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
