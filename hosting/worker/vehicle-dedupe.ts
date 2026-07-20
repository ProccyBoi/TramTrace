export interface VehicleCandidate<RouteName extends string = string> {
  identityKeys: readonly string[];
  route: RouteName;
  direction: 0 | 1;
  stationIndex: number;
  stationName: string;
  reported: boolean;
  distance: number | null;
  state: number;
  timestamp?: number;
  currentStopSequence?: number;
  entityId?: string;
}

function candidateIsBetter<T extends VehicleCandidate>(
  candidate: T,
  existing: T,
): boolean {
  const candidateTimestamp = candidate.timestamp ?? Number.NEGATIVE_INFINITY;
  const existingTimestamp = existing.timestamp ?? Number.NEGATIVE_INFINITY;
  if (candidateTimestamp !== existingTimestamp) {
    return candidateTimestamp > existingTimestamp;
  }

  const candidateSequence =
    candidate.currentStopSequence ?? Number.NEGATIVE_INFINITY;
  const existingSequence =
    existing.currentStopSequence ?? Number.NEGATIVE_INFINITY;
  if (candidateSequence !== existingSequence) {
    return candidateSequence > existingSequence;
  }

  const candidateHasDistance = candidate.distance !== null;
  const existingHasDistance = existing.distance !== null;
  if (candidateHasDistance !== existingHasDistance) {
    return candidateHasDistance;
  }
  if (
    candidate.distance !== null &&
    existing.distance !== null &&
    candidate.distance !== existing.distance
  ) {
    return candidate.distance < existing.distance;
  }
  if (candidate.reported !== existing.reported) {
    return candidate.reported;
  }

  const candidateTie = [
    candidate.entityId || "",
    candidate.route,
    candidate.direction,
    candidate.stationIndex,
  ].join("\u0000");
  const existingTie = [
    existing.entityId || "",
    existing.route,
    existing.direction,
    existing.stationIndex,
  ].join("\u0000");
  return candidateTie < existingTie;
}

export function deduplicateVehicleCandidates<T extends VehicleCandidate>(
  candidates: T[],
): T[] {
  if (candidates.length < 2) {
    return candidates;
  }

  const parents = candidates.map((_, index) => index);
  const find = (initialIndex: number): number => {
    let index = initialIndex;
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  };

  const identityOwner = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    for (const key of candidate.identityKeys) {
      const owner = identityOwner.get(key);
      if (owner === undefined) {
        identityOwner.set(key, index);
      } else {
        union(index, owner);
      }
    }
  });

  const winners = new Map<number, T>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    const existing = winners.get(root);
    if (!existing || candidateIsBetter(candidate, existing)) {
      winners.set(root, candidate);
    }
  });
  return Array.from(winners.values());
}
