const LATEST_MANIFEST_URL =
  "https://github.com/ProccyBoi/TramTrace/releases/latest/download/manifest.json";
const RELEASE_PREFIX =
  "https://github.com/ProccyBoi/TramTrace/releases/download/";
const MAX_MANIFEST_BYTES = 8 * 1024;
const MAX_FIRMWARE_BYTES = 6_400_000;

interface ReleaseManifest {
  schema: 1;
  product: "tramtrace-esp32";
  version: string;
  size: number;
  md5: string;
  sha256: string;
  signature_algorithm: "ecdsa-p256-sha256";
  signing_key: "tramtrace-ota-2026-01";
  signature: string;
  url: string;
}

function parseVersion(value: string): [number, number, number] | null {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    return null;
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 1_000_000)) {
    return null;
  }
  return parts as [number, number, number];
}

function versionIsNewer(candidate: string, current: string): boolean {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  if (!candidateParts || !currentParts) {
    return false;
  }
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const manifest = value as Partial<ReleaseManifest>;
  if (
    manifest.schema !== 1 ||
    manifest.product !== "tramtrace-esp32" ||
    !manifest.version ||
    !parseVersion(manifest.version) ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size! <= 0 ||
    manifest.size! > MAX_FIRMWARE_BYTES ||
    !/^[a-f0-9]{32}$/.test(manifest.md5 || "") ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 || "") ||
    manifest.signature_algorithm !== "ecdsa-p256-sha256" ||
    manifest.signing_key !== "tramtrace-ota-2026-01" ||
    !/^[A-Za-z0-9+/]{32,256}={0,2}$/.test(manifest.signature || "")
  ) {
    return false;
  }

  const expectedUrl =
    `${RELEASE_PREFIX}v${manifest.version}/tramtrace-${manifest.version}.bin`;
  return manifest.url === expectedUrl;
}

async function latestReleaseManifest(): Promise<ReleaseManifest> {
  const response = await fetch(LATEST_MANIFEST_URL, {
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "TramTrace-Sites-OTA/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`manifest HTTP ${response.status}`);
  }
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_MANIFEST_BYTES) {
    throw new Error("manifest is too large");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("manifest is too large");
  }

  const candidate: unknown = JSON.parse(body);
  if (!isReleaseManifest(candidate)) {
    throw new Error("manifest is invalid");
  }
  return candidate;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function firmwareManifest(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const manifest = await latestReleaseManifest();
    const requestUrl = new URL(request.url);
    const current = requestUrl.searchParams.get("current")?.trim() || "";
    const updateAvailable = current
      ? versionIsNewer(manifest.version, current)
      : true;
    const binaryUrl = new URL("/firmware.bin", requestUrl.origin);
    binaryUrl.searchParams.set("version", manifest.version);

    return jsonResponse({
      ...manifest,
      ota_enabled: true,
      update_available: updateAvailable,
      current,
      reason: updateAvailable ? null : "not_newer",
      url: binaryUrl.toString(),
    });
  } catch {
    return jsonResponse({ error: "firmware_manifest_unavailable" }, 503);
  }
}

export async function firmwareBinary(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const requestedVersion =
      new URL(request.url).searchParams.get("version")?.trim() || "";
    const manifest = await latestReleaseManifest();
    if (requestedVersion !== manifest.version) {
      return jsonResponse({ error: "firmware_version_not_found" }, 404);
    }

    const upstream = await fetch(manifest.url, {
      redirect: "follow",
      headers: {
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
        "User-Agent": "TramTrace-Sites-OTA/1.0",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok || !upstream.body) {
      return jsonResponse({ error: "firmware_binary_unavailable" }, 503);
    }
    const declaredSize = Number(upstream.headers.get("content-length") || 0);
    if (declaredSize > 0 && declaredSize !== manifest.size) {
      return jsonResponse({ error: "firmware_binary_size_mismatch" }, 502);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Disposition":
          `attachment; filename="tramtrace-${manifest.version}.bin"`,
        "Content-Length": String(manifest.size),
        "Content-Type": "application/octet-stream",
        ETag: `"${manifest.sha256}"`,
        "X-Content-Type-Options": "nosniff",
        "X-Firmware-MD5": manifest.md5,
        "X-Firmware-SHA256": manifest.sha256,
        "X-Firmware-Version": manifest.version,
      },
    });
  } catch {
    return jsonResponse({ error: "firmware_binary_unavailable" }, 503);
  }
}

export { isReleaseManifest, versionIsNewer };
