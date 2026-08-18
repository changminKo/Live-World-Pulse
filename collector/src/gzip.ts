/** gzip 유틸 — Workers/Node 공통 웹 표준 CompressionStream 사용 */

export async function gzipText(text: string): Promise<ArrayBuffer> {
  const stream = new Response(text).body;
  if (!stream) throw new Error('gzipText: empty body stream');
  return await new Response(stream.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

export async function gunzipToText(data: ArrayBuffer): Promise<string> {
  const stream = new Response(data).body;
  if (!stream) throw new Error('gunzipToText: empty body stream');
  return await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).text();
}
