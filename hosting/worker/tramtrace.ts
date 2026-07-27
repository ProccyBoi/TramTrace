import rawTransitData from "./generated-transit-data.json";
import {
  decodeFeedMessage,
  type FeedMessage,
  type VehiclePosition,
} from "./gtfs-realtime";
import {
  deduplicateVehicleCandidates,
  type VehicleCandidate,
} from "./vehicle-dedupe";
import {
  FeedRefreshCache,
  type FeedRefreshBatch,
} from "./feed-refresh-cache";
import {
  DEFAULT_L4_FAR_METRES,
  farMetresForCandidate,
} from "./station-thresholds";

type Route = "L1" | "L2" | "L3" | "L4";
type SourceName = "innerwest" | "cbdandsoutheast" | "parramatta";
type Direction = 0 | 1;
type StationTuple = [name: string, latitude: number | null, longitude: number | null];
type StateMap = Record<Route, Record<string, [number, number]>>;

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
  filtered: {
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
  TRAMTRACE_L1_VP_URL?: string;
  TRAMTRACE_L23_VP_URL?: string;
  TRAMTRACE_L4_VP_URL?: string;
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
let activeConfiguration = "";
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

async function fetchOne(
  spec: FeedSpec,
  token: string,
): Promise<FeedPart> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(spec.url, {
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
    return {
      spec,
      message,
      receivedAt: Date.now() / 1000,
      headerTimestamp: message.headerTimestamp || 0,
    };
  } finally {
    clearTimeout(timeout);
  }
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

function partAge(part: FeedPart, now: number): number {
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

function resolveVehicle(
  part: FeedPart,
  vehicle: VehiclePosition,
  index: TransitIndex,
): { route: Route; direction: Direction; trip: Trip | null } | null {
  const source = index.sources[part.spec.name];
  const tripId = vehicle.trip?.tripId;
  const trip = tripId ? source.trips[tripId] || null : null;
  let route = trip?.route || null;

  if (!route && vehicle.trip?.routeId) {
    route = source.routeIds[vehicle.trip.routeId] || null;
  }
  if (!route) {
    route =
      routeToken(vehicle.trip?.routeId) || routeToken(vehicle.trip?.tripId);
  }
  if (!route && part.spec.routes.length === 1) {
    route = part.spec.routes[0];
  }
  if (!route && vehicle.stopId) {
    const candidates = part.spec.routes.filter(
      (candidate) => source.stops[candidate]?.[vehicle.stopId!] !== undefined,
    );
    route = candidates.length === 1 ? candidates[0] : null;
  }
  if (!route || !part.spec.routes.includes(route)) {
    return null;
  }

  const rawDirection = vehicle.trip?.directionId;
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

function vehicleIdentityKeys(
  source: SourceName,
  vehicle: VehiclePosition,
): string[] {
  const keys: string[] = [];
  if (vehicle.vehicleId) {
    keys.push(`${source}:vehicle:${vehicle.vehicleId}`);
  }
  if (vehicle.trip?.tripId) {
    const tripInstance = [
      vehicle.trip.tripId,
      vehicle.trip.startDate || "",
      vehicle.trip.startTime || "",
    ].join("|");
    keys.push(`${source}:trip:${tripInstance}`);
  }
  if (vehicle.entityId) {
    keys.push(`${source}:entity:${vehicle.entityId}`);
  }
  return keys;
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
    filtered: {
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

function calculateStateResult(
  parts: FeedPart[],
  index: TransitIndex,
  settings: RuntimeSettings,
  now: number,
): StateCalculation {
  const states = emptyStates(index);
  const l4Processing = emptyL4ProcessingDiagnostics();
  const candidates: VehicleCandidate<Route>[] = [];

  for (const part of parts) {
    for (const vehicle of part.message.vehicles) {
      const isL4Source = part.spec.name === "parramatta";
      if (isL4Source) {
        l4Processing.raw_vehicle_records += 1;
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
        l4Processing.candidate_records += 1;
        if (identityKeys.length === 0) {
          l4Processing.unidentified_candidate_records += 1;
        }
        if (state === 0) {
          l4Processing.candidate_state_records.off += 1;
        } else if (state === 1) {
          l4Processing.candidate_state_records.far += 1;
        } else if (state === 2) {
          l4Processing.candidate_state_records.approaching += 1;
        } else {
          l4Processing.candidate_state_records.at_station += 1;
        }
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
  now: number,
): void {
  const event = {
    event: "tramtrace_l4_processing",
    feed_age_seconds:
      feedAgeSeconds === null ? null : Math.max(0, Math.floor(feedAgeSeconds)),
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
  const boardKey = new URL(request.url).searchParams.get("board_id") || "";
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
  let snapshot: FeedSnapshot;
  try {
    snapshot = await realtimeSnapshot(env, settings, now);
  } catch {
    return jsonResponse({ error: "realtime_feed_unavailable" }, 503);
  }
  now = Date.now() / 1000;
  const freshParts = snapshot.parts.filter((part) => {
    const sourceAge = now - (part.headerTimestamp || part.receivedAt);
    return (
      sourceAge <= settings.maxFeedAgeSeconds &&
      sourceAge >= -settings.futureToleranceSeconds
    );
  });
  if (freshParts.length === 0) {
    return jsonResponse({ error: "realtime_feed_unavailable" }, 503);
  }

  const stateResult = calculateStateResult(
    freshParts,
    TRANSIT.index,
    settings,
    now,
  );
  const l4Part = freshParts.find((part) => part.spec.name === "parramatta");
  logL4Processing(
    stateResult.l4Processing,
    l4Part ? partAge(l4Part, now) : null,
    now,
  );

  return jsonResponse({
    schema: 1,
    timestamp: Math.floor(now),
    feed_age: Math.floor(
      Math.max(...freshParts.map((part) => partAge(part, now))),
    ),
    brightness: settings.brightness,
    poll_seconds: settings.pollSeconds,
    states: stateResult.states,
  });
}

export function tramtraceHealth(env: WorkerEnv): Response {
  const now = Date.now() / 1000;
  const settings = runtimeSettings(env);
  const tokenConfigured = Boolean((env.TFNSW_API_TOKEN || "").trim());
  const staticLoaded = TRANSIT.index !== null;
  const cachedSnapshot = feedCache.peek();
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
  const ok =
    tokenConfigured &&
    staticLoaded &&
    allFeedsFresh &&
    allSchedulesAvailable;
  const cachedParts = cachedSnapshot.parts;
  const freshParts = cachedParts.filter((part) => {
    const sourceAge = now - (part.headerTimestamp || part.receivedAt);
    return (
      sourceAge <= settings.maxFeedAgeSeconds &&
      sourceAge >= -settings.futureToleranceSeconds
    );
  });
  const l4Processing = TRANSIT.index
    ? calculateStateResult(freshParts, TRANSIT.index, settings, now).l4Processing
    : null;
  return jsonResponse(
    {
      ok,
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
      station_thresholds: {
        at_station_metres: settings.atStationMetres,
        approaching_metres: settings.approachingMetres,
        far_metres: settings.farMetres,
        l4_reported_far_metres: settings.l4FarMetres,
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
