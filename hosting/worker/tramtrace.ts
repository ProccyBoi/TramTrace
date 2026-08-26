import rawTransitData from "./generated-transit-data.json";
import {
  decodeFeedMessage,
  type FeedMessage,
  type TripDescriptor,
  type TripUpdate,
  type VehiclePosition,
} from "./gtfs-realtime";
import {
  deduplicateVehicleCandidates,
  type VehicleCandidate,
} from "./vehicle-dedupe";
import {
  FeedRefreshCache,
  type FeedRefreshBatch,
  type FeedRefreshSnapshot,
} from "./feed-refresh-cache";
import {
  DEFAULT_L4_FAR_METRES,
  farMetresForCandidate,
} from "./station-thresholds";
import { selectTripUpdateStop } from "./l4-trip-update";
import { matchEdgeCache, putEdgeCache } from "./edge-cache";

type Route = "L1" | "L2" | "L3" | "L4";
type SourceName = "innerwest" | "cbdandsoutheast" | "parramatta";
type Direction = 0 | 1;
type StationTuple = [name: string, latitude: number | null, longitude: number | null];
type StateMap = Record<Route, Record<string, [number, number]>>;
type L4TripUpdateKey = "parramatta_trip_updates";

interface L4ProcessingDiagnostics {
  raw_vehicle_records: number;
  age_accepted_records: number;
  accepted_with_trip_id_records: number;
  accepted_with_stop_id_records: number;
  accepted_with_position_records: number;
  resolved_route_direction_records: number;
  reported_station_records: number;
  nearest_station_records: number;
  candidate_records: number;
  unidentified_candidate_records: number;
  candidate_state_records: {
    off: number;
    far: number;
    approaching: number;
    at_station: number;
  };
  unique_vehicle_records: number;
  dark_unique_vehicle_records: number;
  visible_vehicle_records: number;
  active_station_direction_slots: number;
  coalesced_visible_vehicle_records: number;
  trip_update_fallback: {
    feed_records: number;
    age_accepted_records: number;
    close_stop_records: number;
    candidate_records: number;
    suppressed_by_fresh_vehicle_position_records: number;
    filtered: {
      stale_timestamp_records: number;
      future_timestamp_records: number;
      unsupported_feed_records: number;
      deleted_or_canceled_records: number;
      ambiguous_trip_records: number;
      ambiguous_identity_records: number;
      no_close_station_records: number;
      unresolved_route_or_direction_records: number;
      unidentified_records: number;
      unknown_station_records: number;
      stop_pattern_mismatch_records: number;
    };
  };
  filtered: {
    deleted_records: number;
    stale_records: number;
    future_records: number;
    unresolved_route_or_direction_records: number;
    no_station_records: number;
    unknown_station_records: number;
    outside_visibility_range_records: number;
    outside_reported_station_range_records: number;
    outside_nearest_station_range_records: number;
    duplicate_records: number;
  };
}

interface StateCalculation {
  states: StateMap;
  l4Processing: L4ProcessingDiagnostics;
}

interface RawRouteData {
  source: string;
  termini: [string, string];
  stations: StationTuple[];
}

interface RawSourceData {
  routeIds: Record<string, Route>;
  directionIds: Partial<Record<Route, Record<string, number>>>;
  stops: Partial<Record<Route, Record<string, number>>>;
  patterns: Partial<Record<Route, Array<Array<[number, number]>>>>;
  trips: Record<string, [Route, number | null, number | null]>;
}

interface RawTransitData {
  schemaVersion: number;
  generatedAt?: string | number;
  routes: Record<Route, RawRouteData>;
  sources: Record<SourceName, RawSourceData>;
}

interface Pattern {
  stationBySequence: Map<number, number>;
  allowedStations: ReadonlySet<number>;
}

interface Trip {
  route: Route;
  direction: Direction | null;
  pattern: Pattern | null;
}

interface TransitIndex {
  generatedAt: number | null;
  routes: Record<Route, RawRouteData>;
  sources: Record<
    SourceName,
    {
      routeIds: Readonly<Record<string, Route>>;
      directionIds: Partial<Record<Route, Readonly<Record<string, number>>>>;
      stops: Partial<Record<Route, Readonly<Record<string, number>>>>;
      trips: Readonly<Record<string, Trip>>;
    }
  >;
}

interface FeedSpec {
  name: SourceName;
  url: string;
  routes: readonly Route[];
}

interface FeedPart {
  spec: FeedSpec;
  message: FeedMessage;
  receivedAt: number;
  headerTimestamp: number;
}

interface FeedSnapshot {
  parts: FeedPart[];
  attemptedAt: number;
  nextAttemptAt: number;
  consecutiveAllFailures: number;
  errors: Partial<Record<SourceName, string>>;
}

interface L4TripUpdatePart {
  message: FeedMessage;
  receivedAt: number;
  headerTimestamp: number;
}

interface WorkerEnv {
  TFNSW_API_TOKEN?: string;
  TRAMTRACE_BOARD_KEY?: string;
  TRAMTRACE_BRIGHTNESS?: string;
  TRAMTRACE_POLL_SECONDS?: string;
  TRAMTRACE_FEED_CACHE_SECONDS?: string;
  TRAMTRACE_MAX_VEHICLE_AGE_SECONDS?: string;
  TRAMTRACE_MAX_FEED_AGE_SECONDS?: string;
  TRAMTRACE_FUTURE_TOLERANCE_SECONDS?: string;
  TRAMTRACE_AT_STATION_METRES?: string;
  TRAMTRACE_APPROACHING_METRES?: string;
  TRAMTRACE_FAR_METRES?: string;
  TRAMTRACE_L4_FAR_METRES?: string;
  TRAMTRACE_L4_TRIP_UPDATE_CACHE_SECONDS?: string;
  TRAMTRACE_L4_TRIP_UPDATE_FAR_SECONDS?: string;
  TRAMTRACE_L1_VP_URL?: string;
  TRAMTRACE_L23_VP_URL?: string;
  TRAMTRACE_L4_VP_URL?: string;
  TRAMTRACE_L4_TRIP_UPDATE_URL?: string;
}

interface RuntimeSettings {
  brightness: number;
  pollSeconds: number;
  cacheSeconds: number;
  maxVehicleAgeSeconds: number;
  maxFeedAgeSeconds: number;
  futureToleranceSeconds: number;
  atStationMetres: number;
  approachingMetres: number;
  farMetres: number;
  l4FarMetres: number;
  l4TripUpdateCacheSeconds: number;
  l4TripUpdateFarSeconds: number;
}

const ROUTES: readonly Route[] = ["L1", "L2", "L3", "L4"];
const SOURCES: readonly SourceName[] = [
  "innerwest",
  "cbdandsoutheast",
  "parramatta",
];
const EXPECTED_STATION_COUNTS: Readonly<Record<Route, number>> = {
  L1: 23,
  L2: 14,
  L3: 15,
  L4: 16,
};
const EXPECTED_TERMINI: Readonly<Record<Route, readonly [string, string]>> = {
  L1: ["Dulwich Hill", "Central"],
  L2: ["Randwick", "Circular Quay"],
  L3: ["Juniors Kingsford", "Circular Quay"],
  L4: ["Westmead", "Carlingford"],
};
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const L4_TRIP_UPDATE_REQUEST_TIMEOUT_MS = 4_000;
const MAX_L4_TRIP_UPDATE_AGE_SECONDS = 90;

function isRoute(value: unknown): value is Route {
  return typeof value === "string" && ROUTES.includes(value as Route);
}

function asDirection(value: unknown): Direction | null {
  return value === 0 || value === 1 ? value : null;
}

function parseGeneratedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value / 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  return null;
}

function buildTransitIndex(
  candidate: unknown,
): { index: TransitIndex | null; error: string | null } {
  try {
    const data = candidate as RawTransitData;
    if (!data || data.schemaVersion !== 1 || !data.routes || !data.sources) {
      throw new Error("unsupported generated transit-data schema");
    }

    for (const route of ROUTES) {
      const routeData = data.routes[route];
      if (
        !routeData ||
        routeData.stations.length !== EXPECTED_STATION_COUNTS[route] ||
        routeData.termini[0] !== EXPECTED_TERMINI[route][0] ||
        routeData.termini[1] !== EXPECTED_TERMINI[route][1]
      ) {
        throw new Error(`generated transit data is incomplete for ${route}`);
      }
      const stationNames = new Set<string>();
      for (const station of routeData.stations) {
        if (
          !Array.isArray(station) ||
          typeof station[0] !== "string" ||
          stationNames.has(station[0])
        ) {
          throw new Error(`generated transit data has invalid ${route} stations`);
        }
        stationNames.add(station[0]);
      }
    }

    const indexedSources = {} as TransitIndex["sources"];
    for (const source of SOURCES) {
      const sourceData = data.sources[source];
      if (!sourceData) {
        throw new Error(`generated transit data is missing ${source}`);
      }

      const trips: Record<string, Trip> = {};
      for (const [tripId, rawTrip] of Object.entries(sourceData.trips)) {
        if (!Array.isArray(rawTrip) || !isRoute(rawTrip[0])) {
          continue;
        }
        const [route, rawDirection, patternIndex] = rawTrip;
        const rawPattern =
          typeof patternIndex === "number"
            ? sourceData.patterns[route]?.[patternIndex]
            : undefined;
        let pattern: Pattern | null = null;
        if (rawPattern) {
          const stationBySequence = new Map<number, number>();
          const allowedStations = new Set<number>();
          for (const pair of rawPattern) {
            const sequence = pair?.[0];
            const stationIndex = pair?.[1];
            if (
              Number.isInteger(sequence) &&
              Number.isInteger(stationIndex) &&
              stationIndex >= 0 &&
              stationIndex < data.routes[route].stations.length
            ) {
              stationBySequence.set(sequence, stationIndex);
              allowedStations.add(stationIndex);
            }
          }
          if (stationBySequence.size > 0) {
            pattern = { stationBySequence, allowedStations };
          }
        }
        trips[tripId] = {
          route,
          direction: asDirection(rawDirection),
          pattern,
        };
      }

      indexedSources[source] = {
        routeIds: sourceData.routeIds,
        directionIds: sourceData.directionIds,
        stops: sourceData.stops,
        trips,
      };
    }

    return {
      index: {
        generatedAt: parseGeneratedAt(data.generatedAt),
        routes: data.routes,
        sources: indexedSources,
      },
      error: null,
    };
  } catch (error) {
    return {
      index: null,
      error: error instanceof Error ? error.message : "invalid generated transit data",
    };
  }
}

const TRANSIT = buildTransitIndex(rawTransitData);

function numberSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function runtimeSettings(env: WorkerEnv): RuntimeSettings {
  const atStationMetres = numberSetting(
    env.TRAMTRACE_AT_STATION_METRES,
    120,
    0,
    5_000,
  );
  const approachingMetres = Math.max(
    atStationMetres,
    numberSetting(env.TRAMTRACE_APPROACHING_METRES, 450, 0, 5_000),
  );
  const farMetres = Math.max(
    approachingMetres,
    numberSetting(env.TRAMTRACE_FAR_METRES, 800, 0, 5_000),
  );
  const l4FarMetres = Math.max(
    approachingMetres,
    numberSetting(
      env.TRAMTRACE_L4_FAR_METRES,
      DEFAULT_L4_FAR_METRES,
      0,
      5_000,
    ),
  );
  return {
    brightness: Math.round(
      numberSetting(env.TRAMTRACE_BRIGHTNESS, 24, 0, 64),
    ),
    pollSeconds: Math.round(
      numberSetting(env.TRAMTRACE_POLL_SECONDS, 3, 1, 60),
    ),
    cacheSeconds: numberSetting(
      env.TRAMTRACE_FEED_CACHE_SECONDS,
      15,
      15,
      60,
    ),
    maxVehicleAgeSeconds: numberSetting(
      env.TRAMTRACE_MAX_VEHICLE_AGE_SECONDS,
      90,
      1,
      900,
    ),
    maxFeedAgeSeconds: numberSetting(
      env.TRAMTRACE_MAX_FEED_AGE_SECONDS,
      120,
      1,
      1_800,
    ),
    futureToleranceSeconds: numberSetting(
      env.TRAMTRACE_FUTURE_TOLERANCE_SECONDS,
      30,
      0,
      300,
    ),
    atStationMetres,
    approachingMetres,
    farMetres,
    l4FarMetres,
    l4TripUpdateCacheSeconds: numberSetting(
      env.TRAMTRACE_L4_TRIP_UPDATE_CACHE_SECONDS,
      60,
      60,
      300,
    ),
    l4TripUpdateFarSeconds: numberSetting(
      env.TRAMTRACE_L4_TRIP_UPDATE_FAR_SECONDS,
      90,
      45,
      180,
    ),
  };
}

function feedSpecs(env: WorkerEnv): FeedSpec[] {
  return [
    {
      name: "innerwest",
      url:
        env.TRAMTRACE_L1_VP_URL ||
        "https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/lightrail/innerwest",
      routes: ["L1"],
    },
    {
      name: "cbdandsoutheast",
      url:
        env.TRAMTRACE_L23_VP_URL ||
        "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/lightrail/cbdandsoutheast",
      routes: ["L2", "L3"],
    },
    {
      name: "parramatta",
      url:
        env.TRAMTRACE_L4_VP_URL ||
        "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/lightrail/parramatta",
      routes: ["L4"],
    },
  ];
}

const feedCache = new FeedRefreshCache<SourceName, FeedPart>();
const l4TripUpdateCache = new FeedRefreshCache<
  L4TripUpdateKey,
  L4TripUpdatePart
>();
let activeConfiguration = "";
let activeL4TripUpdateConfiguration = "";
let lastL4DiagnosticsLogAt = 0;
let lastL4DiagnosticsSignature = "";

function safeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "timeout";
    }
    const httpMatch = /^HTTP (\d{3})$/.exec(error.message);
    if (httpMatch) {
      return `HTTP ${httpMatch[1]}`;
    }
    if (error.message.includes("protobuf")) {
      return "invalid protobuf";
    }
    return error.name || "request failed";
  }
  return "request failed";
}

async function fetchFeedMessage(
  url: string,
  token: string,
  edgeCache?: {
    request: Request;
    key: string;
    maxAgeSeconds: number;
    timeoutMs?: number;
  },
): Promise<L4TripUpdatePart> {
  if (edgeCache) {
    const cached = await matchEdgeCache(edgeCache.request, edgeCache.key);
    if (cached) {
      const body = new Uint8Array(await cached.arrayBuffer());
      if (body.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error("response too large");
      }
      const message = decodeFeedMessage(body);
      const cachedReceivedAt = Number(
        cached.headers.get("X-TramTrace-Received-At"),
      );
      return {
        message,
        receivedAt: Number.isFinite(cachedReceivedAt)
          ? cachedReceivedAt
          : Date.now() / 1000,
        headerTimestamp: message.headerTimestamp || 0,
      };
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    edgeCache?.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `apikey ${token}`,
        Accept: "application/x-protobuf, application/octet-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "tramtrace-worker/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("response too large");
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("response too large");
    }
    const message = decodeFeedMessage(body);
    const receivedAt = Date.now() / 1000;
    const part = {
      message,
      receivedAt,
      headerTimestamp: message.headerTimestamp || 0,
    };
    if (edgeCache) {
      await putEdgeCache(
        edgeCache.request,
        edgeCache.key,
        new Response(body, {
          headers: {
            "Content-Type": "application/x-protobuf",
            "X-TramTrace-Received-At": String(receivedAt),
          },
        }),
        edgeCache.maxAgeSeconds,
      );
    }
    return part;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOne(
  spec: FeedSpec,
  token: string,
): Promise<FeedPart> {
  return {
    spec,
    ...(await fetchFeedMessage(spec.url, token)),
  };
}

async function refreshFeeds(
  token: string,
  specs: FeedSpec[],
): Promise<FeedRefreshBatch<SourceName, FeedPart>> {
  const results = await Promise.allSettled(
    specs.map((spec) => fetchOne(spec, token)),
  );
  const errors: Partial<Record<SourceName, string>> = {};
  const updates: Array<readonly [SourceName, FeedPart]> = [];

  results.forEach((result, index) => {
    const spec = specs[index];
    if (result.status === "fulfilled") {
      updates.push([spec.name, result.value]);
    } else {
      errors[spec.name] = safeFetchError(result.reason);
    }
  });

  return { updates, errors };
}

async function realtimeSnapshot(
  env: WorkerEnv,
  settings: RuntimeSettings,
  now: number,
): Promise<FeedSnapshot> {
  const token = (env.TFNSW_API_TOKEN || "").trim();
  if (!token) {
    throw new Error("missing token");
  }
  const specs = feedSpecs(env);
  const configuration = JSON.stringify([
    token,
    ...specs.map((spec) => spec.url),
  ]);
  if (configuration !== activeConfiguration) {
    feedCache.reset();
    activeConfiguration = configuration;
  }

  return feedCache.getSnapshot(
    now,
    settings.cacheSeconds,
    () => refreshFeeds(token, specs),
    () => Date.now() / 1000,
  );
}

function l4TripUpdateUrl(env: WorkerEnv): string {
  return (
    env.TRAMTRACE_L4_TRIP_UPDATE_URL ||
    "https://api.transport.nsw.gov.au/v1/gtfs/realtime/lightrail/parramatta"
  );
}

function stableCacheKeySuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function realtimeL4TripUpdateSnapshot(
  request: Request,
  env: WorkerEnv,
  settings: RuntimeSettings,
  now: number,
): Promise<FeedRefreshSnapshot<L4TripUpdateKey, L4TripUpdatePart> | null> {
  const token = (env.TFNSW_API_TOKEN || "").trim();
  if (!token) {
    return null;
  }
  const url = l4TripUpdateUrl(env);
  const configuration = JSON.stringify([token, url]);
  if (configuration !== activeL4TripUpdateConfiguration) {
    l4TripUpdateCache.reset();
    activeL4TripUpdateConfiguration = configuration;
  }

  try {
    return await l4TripUpdateCache.getSnapshot(
      now,
      settings.l4TripUpdateCacheSeconds,
      async () => {
        try {
          const part = await fetchFeedMessage(url, token, {
            request,
            key: `l4-trip-updates-v2-${stableCacheKeySuffix(url)}`,
            maxAgeSeconds: settings.l4TripUpdateCacheSeconds,
            timeoutMs: L4_TRIP_UPDATE_REQUEST_TIMEOUT_MS,
          });
          return {
            updates: [["parramatta_trip_updates", part]],
            errors: {},
          };
        } catch (error) {
          return {
            updates: [],
            errors: {
              parramatta_trip_updates: safeFetchError(error),
            },
          };
        }
      },
      () => Date.now() / 1000,
    );
  } catch {
    return null;
  }
}

function partAge(part: FeedPart, now: number): number {
  return Math.max(0, now - (part.headerTimestamp || part.receivedAt));
}

function l4TripUpdatePartAge(
  part: L4TripUpdatePart,
  now: number,
): number {
  return Math.max(0, now - (part.headerTimestamp || part.receivedAt));
}

function emptyStates(index: TransitIndex): StateMap {
  const states = {} as StateMap;
  for (const route of ROUTES) {
    states[route] = {};
    for (const [station] of index.routes[route].stations) {
      states[route][station] = [0, 0];
    }
  }
  return states;
}

function routeToken(value: string | undefined): Route | null {
  const match = /(?:^|[^A-Z0-9])(L[1-4])(?:$|[^A-Z0-9])/.exec(
    (value || "").toUpperCase(),
  );
  return match && isRoute(match[1]) ? match[1] : null;
}

function resolveTripDescriptor(
  spec: FeedSpec,
  descriptor: TripDescriptor | undefined,
  stopId: string | undefined,
  index: TransitIndex,
): { route: Route; direction: Direction; trip: Trip | null } | null {
  const source = index.sources[spec.name];
  const tripId = descriptor?.tripId;
  const trip = tripId ? source.trips[tripId] || null : null;
  let route = trip?.route || null;

  if (!route && descriptor?.routeId) {
    route = source.routeIds[descriptor.routeId] || null;
  }
  if (!route) {
    route =
      routeToken(descriptor?.routeId) || routeToken(descriptor?.tripId);
  }
  if (!route && spec.routes.length === 1) {
    route = spec.routes[0];
  }
  if (!route && stopId) {
    const candidates = spec.routes.filter(
      (candidate) => source.stops[candidate]?.[stopId] !== undefined,
    );
    route = candidates.length === 1 ? candidates[0] : null;
  }
  if (!route || !spec.routes.includes(route)) {
    return null;
  }

  const rawDirection = descriptor?.directionId;
  const checkedDirection =
    rawDirection === 0 || rawDirection === 1
      ? asDirection(source.directionIds[route]?.[String(rawDirection)])
      : null;
  const direction =
    checkedDirection !== null ? checkedDirection : trip?.direction ?? null;
  if (direction === null) {
    return null;
  }
  return { route, direction, trip };
}

function resolveVehicle(
  part: FeedPart,
  vehicle: VehiclePosition,
  index: TransitIndex,
): { route: Route; direction: Direction; trip: Trip | null } | null {
  return resolveTripDescriptor(
    part.spec,
    vehicle.trip,
    vehicle.stopId,
    index,
  );
}

function stationForVehicle(
  source: TransitIndex["sources"][SourceName],
  route: Route,
  vehicle: VehiclePosition,
  trip: Trip | null,
): { stationIndex: number | null; reported: boolean } {
  let stationIndex =
    vehicle.stopId !== undefined
      ? source.stops[route]?.[vehicle.stopId] ?? null
      : null;
  if (
    stationIndex === null &&
    vehicle.currentStopSequence !== undefined &&
    trip?.pattern
  ) {
    stationIndex =
      trip.pattern.stationBySequence.get(vehicle.currentStopSequence) ?? null;
  }
  if (
    stationIndex !== null &&
    trip?.pattern &&
    !trip.pattern.allowedStations.has(stationIndex)
  ) {
    stationIndex = null;
  }
  return { stationIndex, reported: stationIndex !== null };
}

function haversineMetres(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = Math.PI / 180;
  const radius = 6_371_000;
  const latA = latitudeA * radians;
  const latB = latitudeB * radians;
  const deltaLat = latB - latA;
  const deltaLon = (longitudeB - longitudeA) * radians;
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)));
}

function distanceToStation(
  routeData: RawRouteData,
  stationIndex: number,
  vehicle: VehiclePosition,
): number | null {
  if (
    vehicle.latitude === undefined ||
    vehicle.longitude === undefined
  ) {
    return null;
  }
  const station = routeData.stations[stationIndex];
  if (!station || station[1] === null || station[2] === null) {
    return null;
  }
  return haversineMetres(
    vehicle.latitude,
    vehicle.longitude,
    station[1],
    station[2],
  );
}

function nearestStation(
  routeData: RawRouteData,
  vehicle: VehiclePosition,
  allowedStations: ReadonlySet<number> | null,
): { stationIndex: number | null; distance: number | null } {
  if (
    vehicle.latitude === undefined ||
    vehicle.longitude === undefined
  ) {
    return { stationIndex: null, distance: null };
  }

  let bestIndex: number | null = null;
  let bestDistance: number | null = null;
  routeData.stations.forEach((station, stationIndex) => {
    if (allowedStations && !allowedStations.has(stationIndex)) {
      return;
    }
    if (station[1] === null || station[2] === null) {
      return;
    }
    const distance = haversineMetres(
      vehicle.latitude!,
      vehicle.longitude!,
      station[1],
      station[2],
    );
    if (bestDistance === null || distance < bestDistance) {
      bestIndex = stationIndex;
      bestDistance = distance;
    }
  });
  return { stationIndex: bestIndex, distance: bestDistance };
}

function vehicleState(
  route: Route,
  vehicle: VehiclePosition,
  reported: boolean,
  distance: number | null,
  settings: RuntimeSettings,
): number {
  if (vehicle.currentStatus === 1 && reported) {
    return 3;
  }
  if (distance !== null) {
    if (distance <= settings.atStationMetres) {
      return 3;
    }
    if (distance <= settings.approachingMetres) {
      return 2;
    }
    const farMetres = farMetresForCandidate(
      route,
      reported,
      settings.farMetres,
      settings.l4FarMetres,
    );
    if (distance <= farMetres) {
      return 1;
    }
    return 0;
  }
  if (reported) {
    return vehicle.currentStatus === 0 ? 2 : 1;
  }
  return 0;
}

interface RealtimeIdentityRecord {
  vehicleId?: string;
  trip?: TripDescriptor;
  entityId?: string;
}

function tripInstanceIdentityKey(
  source: SourceName,
  descriptor: TripDescriptor,
): string | null {
  if (!descriptor.tripId) {
    return null;
  }
  const tripInstance = [
    descriptor.tripId,
    descriptor.startDate || "",
    descriptor.startTime || "",
  ].join("|");
  return `${source}:trip:${tripInstance}`;
}

function matchableIdentityKeys(
  source: SourceName,
  record: RealtimeIdentityRecord,
): string[] {
  const keys: string[] = [];
  if (record.vehicleId) {
    keys.push(`${source}:vehicle:${record.vehicleId}`);
  }
  if (record.trip) {
    const tripKey = tripInstanceIdentityKey(source, record.trip);
    if (tripKey) {
      keys.push(`${source}:trip-id:${record.trip.tripId}`);
      keys.push(tripKey);
    }
  }
  return keys;
}

function vehicleIdentityKeys(
  source: SourceName,
  vehicle: VehiclePosition,
): string[] {
  const keys = matchableIdentityKeys(source, vehicle);
  if (vehicle.entityId) {
    keys.push(`${source}:entity:${vehicle.entityId}`);
  }
  return keys;
}

function tripUpdateIdentityKeys(
  source: SourceName,
  update: TripUpdate,
): string[] {
  return matchableIdentityKeys(source, update);
}

function realtimeIdentitiesMatch(
  vehicle: VehiclePosition,
  update: TripUpdate,
): boolean {
  if (
    vehicle.vehicleId &&
    update.vehicleId &&
    vehicle.vehicleId === update.vehicleId
  ) {
    return true;
  }
  const vehicleTrip = vehicle.trip;
  const updateTrip = update.trip;
  if (
    !vehicleTrip?.tripId ||
    !updateTrip?.tripId ||
    vehicleTrip.tripId !== updateTrip.tripId
  ) {
    return false;
  }
  if (
    vehicleTrip.startDate &&
    updateTrip.startDate &&
    vehicleTrip.startDate !== updateTrip.startDate
  ) {
    return false;
  }
  if (
    vehicleTrip.startTime &&
    updateTrip.startTime &&
    vehicleTrip.startTime !== updateTrip.startTime
  ) {
    return false;
  }
  return true;
}

function realtimeIdentitiesComparable(
  vehicle: VehiclePosition,
  update: TripUpdate,
): boolean {
  if (
    vehicle.trip?.tripId &&
    update.trip?.tripId &&
    vehicle.trip.tripId === update.trip.tripId &&
    ((vehicle.trip.startDate &&
      update.trip.startDate &&
      vehicle.trip.startDate !== update.trip.startDate) ||
      (vehicle.trip.startTime &&
        update.trip.startTime &&
        vehicle.trip.startTime !== update.trip.startTime))
  ) {
    return false;
  }
  return Boolean(
    (vehicle.vehicleId && update.vehicleId) ||
      (vehicle.trip?.tripId && update.trip?.tripId),
  );
}

function emptyL4ProcessingDiagnostics(): L4ProcessingDiagnostics {
  return {
    raw_vehicle_records: 0,
    age_accepted_records: 0,
    accepted_with_trip_id_records: 0,
    accepted_with_stop_id_records: 0,
    accepted_with_position_records: 0,
    resolved_route_direction_records: 0,
    reported_station_records: 0,
    nearest_station_records: 0,
    candidate_records: 0,
    unidentified_candidate_records: 0,
    candidate_state_records: {
      off: 0,
      far: 0,
      approaching: 0,
      at_station: 0,
    },
    unique_vehicle_records: 0,
    dark_unique_vehicle_records: 0,
    visible_vehicle_records: 0,
    active_station_direction_slots: 0,
    coalesced_visible_vehicle_records: 0,
    trip_update_fallback: {
      feed_records: 0,
      age_accepted_records: 0,
      close_stop_records: 0,
      candidate_records: 0,
      suppressed_by_fresh_vehicle_position_records: 0,
      filtered: {
        stale_timestamp_records: 0,
        future_timestamp_records: 0,
        unsupported_feed_records: 0,
        deleted_or_canceled_records: 0,
        ambiguous_trip_records: 0,
        ambiguous_identity_records: 0,
        no_close_station_records: 0,
        unresolved_route_or_direction_records: 0,
        unidentified_records: 0,
        unknown_station_records: 0,
        stop_pattern_mismatch_records: 0,
      },
    },
    filtered: {
      deleted_records: 0,
      stale_records: 0,
      future_records: 0,
      unresolved_route_or_direction_records: 0,
      no_station_records: 0,
      unknown_station_records: 0,
      outside_visibility_range_records: 0,
      outside_reported_station_range_records: 0,
      outside_nearest_station_range_records: 0,
      duplicate_records: 0,
    },
  };
}

function recordL4CandidateState(
  diagnostics: L4ProcessingDiagnostics,
  state: number,
  unidentified: boolean,
): void {
  diagnostics.candidate_records += 1;
  if (unidentified) {
    diagnostics.unidentified_candidate_records += 1;
  }
  if (state === 0) {
    diagnostics.candidate_state_records.off += 1;
  } else if (state === 1) {
    diagnostics.candidate_state_records.far += 1;
  } else if (state === 2) {
    diagnostics.candidate_state_records.approaching += 1;
  } else {
    diagnostics.candidate_state_records.at_station += 1;
  }
}

function tripUpdateGroupKey(update: TripUpdate): string | null {
  if (!update.trip?.tripId) {
    return null;
  }
  return [
    update.trip.tripId,
    update.trip.startDate || "",
    update.trip.startTime || "",
  ].join("|");
}

function newerTripUpdate(
  candidate: TripUpdate,
  existing: TripUpdate,
  fallbackTimestamp: number,
): boolean {
  const candidateTimestamp = candidate.timestamp ?? fallbackTimestamp;
  const existingTimestamp = existing.timestamp ?? fallbackTimestamp;
  if (candidateTimestamp !== existingTimestamp) {
    return candidateTimestamp > existingTimestamp;
  }
  const candidateSuppresses =
    candidate.isDeleted ||
    (candidate.trip?.scheduleRelationship !== undefined &&
      candidate.trip.scheduleRelationship !== 0);
  const existingSuppresses =
    existing.isDeleted ||
    (existing.trip?.scheduleRelationship !== undefined &&
      existing.trip.scheduleRelationship !== 0);
  if (candidateSuppresses !== existingSuppresses) {
    return candidateSuppresses;
  }
  return (candidate.entityId || "") < (existing.entityId || "");
}

function calculateStateResult(
  parts: FeedPart[],
  index: TransitIndex,
  settings: RuntimeSettings,
  now: number,
  l4TripUpdatePart: L4TripUpdatePart | null = null,
): StateCalculation {
  const states = emptyStates(index);
  const l4Processing = emptyL4ProcessingDiagnostics();
  const candidates: VehicleCandidate<Route>[] = [];
  const freshL4AuthorityVehicles: VehiclePosition[] = [];
  let hasUnmatchableFreshL4Candidate = false;

  for (const part of parts) {
    for (const vehicle of part.message.vehicles) {
      const isL4Source = part.spec.name === "parramatta";
      if (isL4Source) {
        l4Processing.raw_vehicle_records += 1;
      }
      if (vehicle.isDeleted) {
        if (isL4Source) {
          l4Processing.filtered.deleted_records += 1;
        }
        continue;
      }
      if (vehicle.timestamp !== undefined) {
        const age = now - vehicle.timestamp;
        if (
          age > settings.maxVehicleAgeSeconds ||
          age < -settings.futureToleranceSeconds
        ) {
          if (isL4Source) {
            if (age > settings.maxVehicleAgeSeconds) {
              l4Processing.filtered.stale_records += 1;
            } else {
              l4Processing.filtered.future_records += 1;
            }
          }
          continue;
        }
      }
      if (isL4Source) {
        l4Processing.age_accepted_records += 1;
        if (vehicle.trip?.tripId) {
          l4Processing.accepted_with_trip_id_records += 1;
        }
        if (vehicle.stopId) {
          l4Processing.accepted_with_stop_id_records += 1;
        }
        if (
          vehicle.latitude !== undefined &&
          vehicle.longitude !== undefined
        ) {
          l4Processing.accepted_with_position_records += 1;
        }
        freshL4AuthorityVehicles.push(vehicle);
        if (matchableIdentityKeys(part.spec.name, vehicle).length === 0) {
          hasUnmatchableFreshL4Candidate = true;
        }
      }

      const resolved = resolveVehicle(part, vehicle, index);
      if (!resolved) {
        if (isL4Source) {
          l4Processing.filtered.unresolved_route_or_direction_records += 1;
        }
        continue;
      }
      if (resolved.route === "L4") {
        l4Processing.resolved_route_direction_records += 1;
      }
      const source = index.sources[part.spec.name];
      const routeData = index.routes[resolved.route];
      const station = stationForVehicle(
        source,
        resolved.route,
        vehicle,
        resolved.trip,
      );
      let { stationIndex } = station;
      const { reported } = station;
      let distance =
        stationIndex === null
          ? null
          : distanceToStation(routeData, stationIndex, vehicle);
      if (stationIndex === null) {
        const nearest = nearestStation(
          routeData,
          vehicle,
          resolved.trip?.pattern?.allowedStations || null,
        );
        stationIndex = nearest.stationIndex;
        distance = nearest.distance;
      }
      if (stationIndex === null) {
        if (resolved.route === "L4") {
          l4Processing.filtered.no_station_records += 1;
        }
        continue;
      }
      const state = vehicleState(
        resolved.route,
        vehicle,
        reported,
        distance,
        settings,
      );
      const stationName = routeData.stations[stationIndex]?.[0];
      if (!stationName || !states[resolved.route][stationName]) {
        if (resolved.route === "L4") {
          l4Processing.filtered.unknown_station_records += 1;
        }
        continue;
      }
      const identityKeys = vehicleIdentityKeys(part.spec.name, vehicle);
      if (resolved.route === "L4") {
        if (reported) {
          l4Processing.reported_station_records += 1;
        } else {
          l4Processing.nearest_station_records += 1;
        }
        recordL4CandidateState(
          l4Processing,
          state,
          identityKeys.length === 0,
        );
        if (state <= 0) {
          l4Processing.filtered.outside_visibility_range_records += 1;
          if (reported) {
            l4Processing.filtered.outside_reported_station_range_records += 1;
          } else {
            l4Processing.filtered.outside_nearest_station_range_records += 1;
          }
        }
      }
      candidates.push({
        identityKeys,
        route: resolved.route,
        direction: resolved.direction,
        stationIndex,
        stationName,
        reported,
        distance,
        state,
        timestamp: vehicle.timestamp,
        currentStopSequence: vehicle.currentStopSequence,
        entityId: vehicle.entityId,
      });
    }
  }

  if (l4TripUpdatePart) {
    const fallback = l4Processing.trip_update_fallback;
    const updates = l4TripUpdatePart.message.tripUpdates;
    fallback.feed_records = updates.length;

    if (l4TripUpdatePart.message.incrementality !== 0) {
      fallback.filtered.unsupported_feed_records = updates.length;
    } else {
      const fallbackTimestamp =
        l4TripUpdatePart.headerTimestamp || l4TripUpdatePart.receivedAt;
      const newestByTripInstance = new Map<string, TripUpdate>();
      const groupKeysByTripId = new Map<string, Set<string>>();

      for (const update of updates) {
        const updateTimestamp = update.timestamp ?? fallbackTimestamp;
        const updateAge = now - updateTimestamp;
        if (updateAge < -settings.futureToleranceSeconds) {
          fallback.filtered.future_timestamp_records += 1;
          continue;
        }
        // TfNSW keeps some active-trip entity timestamps unchanged even while
        // publishing a fresh FULL_DATASET feed. Retain that diagnostic, but
        // let the current feed header plus the strict stop-event window decide
        // whether the trip is close enough to display.
        if (
          update.timestamp !== undefined &&
          updateAge > MAX_L4_TRIP_UPDATE_AGE_SECONDS
        ) {
          fallback.filtered.stale_timestamp_records += 1;
        }
        fallback.age_accepted_records += 1;

        const groupKey = tripUpdateGroupKey(update);
        const tripId = update.trip?.tripId;
        if (!groupKey || !tripId) {
          fallback.filtered.unidentified_records += 1;
          continue;
        }
        const tripGroups = groupKeysByTripId.get(tripId) || new Set<string>();
        tripGroups.add(groupKey);
        groupKeysByTripId.set(tripId, tripGroups);

        const existing = newestByTripInstance.get(groupKey);
        if (
          !existing ||
          newerTripUpdate(update, existing, fallbackTimestamp)
        ) {
          newestByTripInstance.set(groupKey, update);
        }
      }

      const source = index.sources.parramatta;
      const routeData = index.routes.L4;
      for (const [groupKey, update] of newestByTripInstance) {
        const tripId = update.trip?.tripId;
        if (!tripId) {
          fallback.filtered.unidentified_records += 1;
          continue;
        }
        if ((groupKeysByTripId.get(tripId)?.size || 0) > 1) {
          fallback.filtered.ambiguous_trip_records += 1;
          continue;
        }
        if (
          update.isDeleted ||
          (update.trip?.scheduleRelationship !== undefined &&
            update.trip.scheduleRelationship !== 0)
        ) {
          fallback.filtered.deleted_or_canceled_records += 1;
          continue;
        }

        const trip = source.trips[tripId];
        const descriptorRoute = update.trip?.routeId
          ? source.routeIds[update.trip.routeId]
          : undefined;
        const descriptorDirection =
          update.trip?.directionId === 0 ||
          update.trip?.directionId === 1
            ? asDirection(
                source.directionIds.L4?.[
                  String(update.trip.directionId)
                ],
              )
            : null;
        if (
          !trip ||
          trip.route !== "L4" ||
          trip.direction === null ||
          !trip.pattern ||
          (descriptorRoute !== undefined && descriptorRoute !== "L4") ||
          (descriptorDirection !== null &&
            descriptorDirection !== trip.direction)
        ) {
          fallback.filtered.unresolved_route_or_direction_records += 1;
          continue;
        }

        const selected = selectTripUpdateStop(
          update,
          now,
          {
            atStationSeconds: 15,
            approachingSeconds: 45,
            farSeconds: settings.l4TripUpdateFarSeconds,
          },
          (stopId) => source.stops.L4?.[stopId] !== undefined,
        );
        if (!selected) {
          fallback.filtered.no_close_station_records += 1;
          continue;
        }
        fallback.close_stop_records += 1;

        const stationIndex = source.stops.L4?.[selected.stopId];
        if (stationIndex === undefined) {
          fallback.filtered.unknown_station_records += 1;
          continue;
        }
        if (
          !trip.pattern.allowedStations.has(stationIndex) ||
          (selected.stopSequence !== undefined &&
            trip.pattern.stationBySequence.get(selected.stopSequence) !==
              stationIndex)
        ) {
          fallback.filtered.stop_pattern_mismatch_records += 1;
          continue;
        }
        const stationName = routeData.stations[stationIndex]?.[0];
        if (!stationName || !states.L4[stationName]) {
          fallback.filtered.unknown_station_records += 1;
          continue;
        }

        const identityKeys = tripUpdateIdentityKeys("parramatta", update);
        if (identityKeys.length === 0) {
          fallback.filtered.unidentified_records += 1;
          continue;
        }
        const matchedFreshVehicle = freshL4AuthorityVehicles.some((vehicle) =>
          realtimeIdentitiesMatch(vehicle, update),
        );
        if (matchedFreshVehicle) {
          fallback.suppressed_by_fresh_vehicle_position_records += 1;
          continue;
        }
        if (
          hasUnmatchableFreshL4Candidate ||
          freshL4AuthorityVehicles.some(
            (vehicle) => !realtimeIdentitiesComparable(vehicle, update),
          )
        ) {
          fallback.filtered.ambiguous_identity_records += 1;
          continue;
        }

        fallback.candidate_records += 1;
        recordL4CandidateState(l4Processing, selected.state, false);
        candidates.push({
          identityKeys,
          route: "L4",
          direction: trip.direction,
          stationIndex,
          stationName,
          reported: true,
          distance: null,
          state: selected.state,
          // If one physical vehicle is attached to two block trips, the
          // closest stop wins the existing identity-based dedupe.
          timestamp:
            now - Math.max(0, selected.arrivalTime - now),
          currentStopSequence: selected.stopSequence,
          entityId: update.entityId || groupKey,
        });
      }
    }
  }

  const uniqueCandidates = deduplicateVehicleCandidates(candidates);
  for (const candidate of uniqueCandidates) {
    if (candidate.route === "L4") {
      l4Processing.unique_vehicle_records += 1;
      if (candidate.state > 0) {
        l4Processing.visible_vehicle_records += 1;
      } else {
        l4Processing.dark_unique_vehicle_records += 1;
      }
    }
    if (candidate.state <= 0) {
      continue;
    }
    states[candidate.route][candidate.stationName][candidate.direction] =
      Math.max(
        states[candidate.route][candidate.stationName][candidate.direction],
        candidate.state,
    );
  }

  l4Processing.filtered.duplicate_records = Math.max(
    0,
    l4Processing.candidate_records - l4Processing.unique_vehicle_records,
  );
  l4Processing.active_station_direction_slots = Object.values(states.L4).reduce(
    (total, directions) =>
      total + Number(directions[0] > 0) + Number(directions[1] > 0),
    0,
  );
  l4Processing.coalesced_visible_vehicle_records = Math.max(
    0,
    l4Processing.visible_vehicle_records -
      l4Processing.active_station_direction_slots,
  );

  return { states, l4Processing };
}

function logL4Processing(
  diagnostics: L4ProcessingDiagnostics,
  feedAgeSeconds: number | null,
  tripUpdateFeedAgeSeconds: number | null,
  now: number,
): void {
  const event = {
    event: "tramtrace_l4_processing",
    feed_age_seconds:
      feedAgeSeconds === null ? null : Math.max(0, Math.floor(feedAgeSeconds)),
    trip_update_feed_age_seconds:
      tripUpdateFeedAgeSeconds === null
        ? null
        : Math.max(0, Math.floor(tripUpdateFeedAgeSeconds)),
    ...diagnostics,
  };
  const signature = JSON.stringify(diagnostics);
  if (
    signature === lastL4DiagnosticsSignature &&
    now - lastL4DiagnosticsLogAt < 60
  ) {
    return;
  }
  console.log(JSON.stringify(event));
  lastL4DiagnosticsSignature = signature;
  lastL4DiagnosticsLogAt = now;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function boardAccessKey(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    return match?.[1] || "";
  }

  // Compatibility for firmware through 0.3.1. New firmware never places the
  // access key in a URL because query strings can be retained in access logs.
  return new URL(request.url).searchParams.get("board_id") || "";
}

export async function tramtracePayload(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const expectedBoardKey = env.TRAMTRACE_BOARD_KEY || "";
  if (!expectedBoardKey) {
    return jsonResponse({ error: "service_not_configured" }, 503);
  }
  const boardKey = boardAccessKey(request);
  if (!constantTimeEqual(boardKey, expectedBoardKey)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!TRANSIT.index) {
    return jsonResponse({ error: "static_gtfs_unavailable" }, 503);
  }
  if (!(env.TFNSW_API_TOKEN || "").trim()) {
    return jsonResponse({ error: "missing_tfnsw_api_token" }, 503);
  }

  let now = Date.now() / 1000;
  const settings = runtimeSettings(env);
  const cachedPayload = await matchEdgeCache(request, "board-payload-v2");
  if (cachedPayload) {
    return new Response(cachedPayload.body, {
      status: cachedPayload.status,
      statusText: cachedPayload.statusText,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }

  let snapshot: FeedSnapshot;
  let l4TripUpdateSnapshot:
    | FeedRefreshSnapshot<L4TripUpdateKey, L4TripUpdatePart>
    | null;
  try {
    [snapshot, l4TripUpdateSnapshot] = await Promise.all([
      realtimeSnapshot(env, settings, now),
      realtimeL4TripUpdateSnapshot(request, env, settings, now),
    ]);
  } catch {
    return jsonResponse({ error: "realtime_feed_unavailable" }, 503);
  }
  now = Date.now() / 1000;
  const freshParts = snapshot.parts.filter((part) => {
    const sourceAge = now - (part.headerTimestamp || part.receivedAt);
    return (
      part.message.incrementality === 0 &&
      sourceAge <= settings.maxFeedAgeSeconds &&
      sourceAge >= -settings.futureToleranceSeconds
    );
  });
  if (freshParts.length === 0) {
    return jsonResponse({ error: "realtime_feed_unavailable" }, 503);
  }

  const l4TripUpdatePart =
    l4TripUpdateSnapshot?.parts.find(
      (part) => {
        const sourceAge =
          now - (part.headerTimestamp || part.receivedAt);
        return (
          sourceAge <= MAX_L4_TRIP_UPDATE_AGE_SECONDS &&
          sourceAge >= -settings.futureToleranceSeconds
        );
      },
    ) || null;
  const stateResult = calculateStateResult(
    freshParts,
    TRANSIT.index,
    settings,
    now,
    l4TripUpdatePart,
  );
  const l4Part = freshParts.find((part) => part.spec.name === "parramatta");
  logL4Processing(
    stateResult.l4Processing,
    l4Part ? partAge(l4Part, now) : null,
    l4TripUpdatePart
      ? l4TripUpdatePartAge(l4TripUpdatePart, now)
      : null,
    now,
  );

  const response = jsonResponse({
    schema: 1,
    timestamp: Math.floor(now),
    feed_age: Math.floor(
      Math.max(...freshParts.map((part) => partAge(part, now))),
    ),
    brightness: settings.brightness,
    poll_seconds: settings.pollSeconds,
    states: stateResult.states,
  });
  await putEdgeCache(
    request,
    "board-payload-v2",
    response.clone(),
    settings.cacheSeconds,
  );
  return response;
}

export function tramtraceHealth(env: WorkerEnv): Response {
  const now = Date.now() / 1000;
  const settings = runtimeSettings(env);
  const tokenConfigured = Boolean((env.TFNSW_API_TOKEN || "").trim());
  const staticLoaded = TRANSIT.index !== null;
  const cachedSnapshot = feedCache.peek();
  const cachedL4TripUpdateSnapshot = l4TripUpdateCache.peek();
  const feedParts = new Map(
    cachedSnapshot.parts.map((part) => [part.spec.name, part]),
  );
  const feedErrors = cachedSnapshot.errors;
  const feeds = {} as Record<
    SourceName,
    { available: boolean; fresh: boolean; age: number | null; error: string | null }
  >;

  for (const source of SOURCES) {
    const part = feedParts.get(source);
    const sourceAge = part
      ? now - (part.headerTimestamp || part.receivedAt)
      : null;
    feeds[source] = {
      available: Boolean(part),
      fresh:
        sourceAge !== null &&
        sourceAge <= settings.maxFeedAgeSeconds &&
        sourceAge >= -settings.futureToleranceSeconds,
      age: part ? Math.floor(partAge(part, now)) : null,
      error: feedErrors[source] || null,
    };
  }

  const schedules = {} as Record<
    SourceName,
    { available: boolean; age: number | null; error: string | null }
  >;
  for (const source of SOURCES) {
    const available = Boolean(TRANSIT.index?.sources[source]);
    schedules[source] = {
      available,
      age:
        available && TRANSIT.index?.generatedAt
          ? Math.floor(Math.max(0, now - TRANSIT.index.generatedAt))
          : null,
      error: available ? null : "unavailable",
    };
  }

  const allFeedsFresh = SOURCES.every((source) => feeds[source].fresh);
  const allSchedulesAvailable = SOURCES.every(
    (source) => schedules[source].available,
  );
  // A fresh Worker isolate has no feed cache until the first authenticated
  // payload request. Health therefore reports deployment readiness separately
  // from the optional realtime-cache snapshot.
  const ok = tokenConfigured && staticLoaded && allSchedulesAvailable;
  const cachedParts = cachedSnapshot.parts;
  const freshParts = cachedParts.filter((part) => {
    const sourceAge = now - (part.headerTimestamp || part.receivedAt);
    return (
      part.message.incrementality === 0 &&
      sourceAge <= settings.maxFeedAgeSeconds &&
      sourceAge >= -settings.futureToleranceSeconds
    );
  });
  const cachedL4TripUpdatePart =
    cachedL4TripUpdateSnapshot.parts[0] || null;
  const cachedL4TripUpdateAge = cachedL4TripUpdatePart
    ? now -
      (cachedL4TripUpdatePart.headerTimestamp ||
        cachedL4TripUpdatePart.receivedAt)
    : null;
  const freshL4TripUpdatePart =
    cachedL4TripUpdatePart &&
    cachedL4TripUpdateAge !== null &&
    cachedL4TripUpdateAge <= MAX_L4_TRIP_UPDATE_AGE_SECONDS &&
    cachedL4TripUpdateAge >= -settings.futureToleranceSeconds
      ? cachedL4TripUpdatePart
      : null;
  const l4Processing = TRANSIT.index
    ? calculateStateResult(
        freshParts,
        TRANSIT.index,
        settings,
        now,
        freshL4TripUpdatePart,
      ).l4Processing
    : null;
  return jsonResponse(
    {
      ok,
      live_data_ready: allFeedsFresh,
      token_configured: tokenConfigured,
      static_loaded: staticLoaded,
      static_age:
        TRANSIT.index?.generatedAt !== null &&
        TRANSIT.index?.generatedAt !== undefined
          ? Math.floor(Math.max(0, now - TRANSIT.index.generatedAt))
          : null,
      feed_age:
        cachedParts.length > 0
          ? Math.floor(
              Math.max(...cachedParts.map((part) => partAge(part, now))),
            )
          : null,
      upstream: {
        cache_seconds: settings.cacheSeconds,
        last_attempt_age:
          cachedSnapshot.attemptedAt > 0
            ? Math.floor(Math.max(0, now - cachedSnapshot.attemptedAt))
            : null,
        retry_in: Math.ceil(
          Math.max(0, cachedSnapshot.nextAttemptAt - now),
        ),
        consecutive_all_feed_failures:
          cachedSnapshot.consecutiveAllFailures,
      },
      l4_trip_updates: {
        available: Boolean(cachedL4TripUpdatePart),
        fresh: Boolean(freshL4TripUpdatePart),
        age: cachedL4TripUpdatePart
          ? Math.floor(l4TripUpdatePartAge(cachedL4TripUpdatePart, now))
          : null,
        error:
          cachedL4TripUpdateSnapshot.errors.parramatta_trip_updates || null,
        cache_seconds: settings.l4TripUpdateCacheSeconds,
        last_attempt_age:
          cachedL4TripUpdateSnapshot.attemptedAt > 0
            ? Math.floor(
                Math.max(
                  0,
                  now - cachedL4TripUpdateSnapshot.attemptedAt,
                ),
              )
            : null,
        retry_in: Math.ceil(
          Math.max(0, cachedL4TripUpdateSnapshot.nextAttemptAt - now),
        ),
      },
      station_thresholds: {
        at_station_metres: settings.atStationMetres,
        approaching_metres: settings.approachingMetres,
        far_metres: settings.farMetres,
        l4_reported_far_metres: settings.l4FarMetres,
        l4_trip_update_at_station_seconds: 15,
        l4_trip_update_approaching_seconds: 45,
        l4_trip_update_far_seconds: settings.l4TripUpdateFarSeconds,
        maximum_vehicle_age_seconds: settings.maxVehicleAgeSeconds,
      },
      l4_processing: l4Processing,
      feeds,
      schedules,
      error: TRANSIT.error,
    },
    ok ? 200 : 503,
  );
}

export type { WorkerEnv };
