// For tests only (unit and e2e): reads a whole request's calls back into shapes, to check what a refusal left. The
// extension itself goes message by message (mtproto.ts refuseWrites) and never imports this file.
import { calls, requestBody, shapeOfCall } from './mtproto';

/** The shapes of every call in a request, or one unparseable write when it cannot be read. Undefined when the
 *  plaintext is not a request at all (the key exchange's data). */
export async function shapesOf(plain: Uint8Array, table: Map<number, string>): Promise<string[] | undefined> {
  const body = requestBody(plain);
  if (!body) return undefined;
  try {
    return (await calls(body)).map((id) => shapeOfCall(id, table));
  } catch {
    return ['telegram:w[unparseable]'];
  }
}
