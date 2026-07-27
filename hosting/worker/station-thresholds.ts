export const DEFAULT_L4_FAR_METRES = 1_700;

export function farMetresForCandidate(
  route: string,
  reportedStation: boolean,
  defaultFarMetres: number,
  l4FarMetres: number,
): number {
  return route === "L4" && reportedStation
    ? l4FarMetres
    : defaultFarMetres;
}
