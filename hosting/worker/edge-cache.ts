interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultEdgeCache(): EdgeCache | null {
  const cacheStorage = (
    globalThis as typeof globalThis & {
      caches?: { default?: EdgeCache };
    }
  ).caches;
  return cacheStorage?.default || null;
}

function cacheRequest(request: Request, key: string): Request {
  const url = new URL(request.url);
  url.pathname = `/__tramtrace_cache/${key}`;
  url.search = "";
  url.hash = "";
  return new Request(url, { method: "GET" });
}

export async function matchEdgeCache(
  request: Request,
  key: string,
): Promise<Response | null> {
  const cache = defaultEdgeCache();
  if (!cache) {
    return null;
  }
  try {
    return (await cache.match(cacheRequest(request, key))) || null;
  } catch {
    return null;
  }
}

export async function putEdgeCache(
  request: Request,
  key: string,
  response: Response,
  maxAgeSeconds: number,
): Promise<void> {
  const cache = defaultEdgeCache();
  if (!cache) {
    return;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "Cache-Control",
    `public, max-age=${Math.max(1, Math.floor(maxAgeSeconds))}`,
  );
  try {
    await cache.put(
      cacheRequest(request, key),
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
  } catch {
    // The in-memory refresh caches remain a safe fallback if edge caching is
    // unavailable in a local runtime or a particular Cloudflare invocation.
  }
}
