export async function fetchImage(fetchImpl, source, headers = {}) {
  const response = await fetchImpl(source, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
  const type = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!response.ok || !/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(type)) throw new Error(`Artwork request failed (HTTP ${response.status}).`);
  const limit = 5 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Artwork exceeds 5 MiB.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Artwork exceeds 5 MiB.");
    chunks.push(Buffer.from(chunk));
  }
  return { type, body: Buffer.concat(chunks) };
}
