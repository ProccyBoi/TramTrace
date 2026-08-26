/**
 * Minimal, dependency-free GTFS-Realtime decoder.
 *
 * TfNSW's endpoints return standard GTFS-Realtime protobufs. TramTrace only
 * needs FeedHeader.timestamp plus focused VehiclePosition and TripUpdate
 * subsets, so decoding those fields directly keeps the deployed Worker small
 * and avoids a Node-specific protobuf runtime.
 */

export interface TripDescriptor {
  tripId?: string;
  startTime?: string;
  startDate?: string;
  scheduleRelationship?: number;
  routeId?: string;
  directionId?: number;
}

export interface VehiclePosition {
  entityId?: string;
  isDeleted: boolean;
  vehicleId?: string;
  trip?: TripDescriptor;
  stopId?: string;
  currentStopSequence?: number;
  currentStatus: number;
  latitude?: number;
  longitude?: number;
  timestamp?: number;
}

export interface StopTimeUpdate {
  stopSequence?: number;
  arrivalTime?: number;
  departureTime?: number;
  stopId?: string;
  scheduleRelationship?: number;
}

export interface TripUpdate {
  entityId?: string;
  isDeleted: boolean;
  trip?: TripDescriptor;
  timestamp?: number;
  stopTimeUpdates: StopTimeUpdate[];
  vehicleId?: string;
}

export interface FeedMessage {
  headerTimestamp?: number;
  incrementality: number;
  vehicles: VehiclePosition[];
  tripUpdates: TripUpdate[];
}

class ProtobufReader {
  readonly bytes: Uint8Array;
  offset: number;
  readonly end: number;

  constructor(bytes: Uint8Array, offset = 0, end = bytes.length) {
    this.bytes = bytes;
    this.offset = offset;
    this.end = end;
  }

  get done(): boolean {
    return this.offset >= this.end;
  }

  uint64(): number {
    let value = 0;
    let multiplier = 1;

    for (let count = 0; count < 10; count += 1) {
      if (this.offset >= this.end) {
        throw new Error("truncated protobuf varint");
      }
      const byte = this.bytes[this.offset];
      this.offset += 1;
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) {
          throw new Error("protobuf integer exceeds JavaScript safe range");
        }
        return value;
      }
      multiplier *= 128;
    }

    throw new Error("invalid protobuf varint");
  }

  tag(): { field: number; wire: number } {
    const tag = this.uint64();
    const field = Math.floor(tag / 8);
    const wire = tag & 0x07;
    if (field <= 0) {
      throw new Error("invalid protobuf field number");
    }
    return { field, wire };
  }

  bytesField(): Uint8Array {
    const length = this.uint64();
    const end = this.offset + length;
    if (length < 0 || end > this.end) {
      throw new Error("truncated protobuf field");
    }
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  string(): string {
    return new TextDecoder().decode(this.bytesField());
  }

  float32(): number {
    if (this.offset + 4 > this.end) {
      throw new Error("truncated protobuf float");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    ).getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.skipVarint();
        return;
      case 1:
        this.advance(8);
        return;
      case 2:
        this.bytesField();
        return;
      case 5:
        this.advance(4);
        return;
      default:
        throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }

  private advance(length: number): void {
    if (this.offset + length > this.end) {
      throw new Error("truncated protobuf field");
    }
    this.offset += length;
  }

  private skipVarint(): void {
    for (let count = 0; count < 10; count += 1) {
      if (this.offset >= this.end) {
        throw new Error("truncated protobuf varint");
      }
      const byte = this.bytes[this.offset];
      this.offset += 1;
      if ((byte & 0x80) === 0) {
        return;
      }
    }
    throw new Error("invalid protobuf varint");
  }
}

interface DecodedHeader {
  incrementality: number;
  timestamp?: number;
}

function decodeHeader(bytes: Uint8Array): DecodedHeader {
  const reader = new ProtobufReader(bytes);
  // FeedHeader.incrementality defaults to FULL_DATASET (0) in the proto.
  let incrementality = 0;
  let timestamp: number | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 0) {
      incrementality = reader.uint64();
    } else if (field === 3 && wire === 0) {
      timestamp = reader.uint64();
    } else {
      reader.skip(wire);
    }
  }

  return { incrementality, timestamp };
}

function decodeTrip(bytes: Uint8Array): TripDescriptor {
  const reader = new ProtobufReader(bytes);
  const trip: TripDescriptor = {};

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      trip.tripId = reader.string() || undefined;
    } else if (field === 2 && wire === 2) {
      trip.startTime = reader.string() || undefined;
    } else if (field === 3 && wire === 2) {
      trip.startDate = reader.string() || undefined;
    } else if (field === 4 && wire === 0) {
      trip.scheduleRelationship = reader.uint64();
    } else if (field === 5 && wire === 2) {
      trip.routeId = reader.string() || undefined;
    } else if (field === 6 && wire === 0) {
      trip.directionId = reader.uint64();
    } else {
      reader.skip(wire);
    }
  }

  return trip;
}

function decodePosition(
  bytes: Uint8Array,
): Pick<VehiclePosition, "latitude" | "longitude"> {
  const reader = new ProtobufReader(bytes);
  let latitude: number | undefined;
  let longitude: number | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 5) {
      latitude = reader.float32();
    } else if (field === 2 && wire === 5) {
      longitude = reader.float32();
    } else {
      reader.skip(wire);
    }
  }

  return { latitude, longitude };
}

function decodeVehicleDescriptor(bytes: Uint8Array): string | undefined {
  const reader = new ProtobufReader(bytes);
  let vehicleId: string | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      vehicleId = reader.string() || undefined;
    } else {
      reader.skip(wire);
    }
  }

  return vehicleId;
}

function decodeStopTimeEventTime(bytes: Uint8Array): number | undefined {
  const reader = new ProtobufReader(bytes);
  let time: number | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 0) {
      time = reader.uint64();
    } else {
      reader.skip(wire);
    }
  }

  return time;
}

function decodeStopTimeUpdate(bytes: Uint8Array): StopTimeUpdate {
  const reader = new ProtobufReader(bytes);
  const update: StopTimeUpdate = {};

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 0) {
      update.stopSequence = reader.uint64();
    } else if (field === 2 && wire === 2) {
      update.arrivalTime = decodeStopTimeEventTime(reader.bytesField());
    } else if (field === 3 && wire === 2) {
      update.departureTime = decodeStopTimeEventTime(reader.bytesField());
    } else if (field === 4 && wire === 2) {
      update.stopId = reader.string() || undefined;
    } else if (field === 5 && wire === 0) {
      update.scheduleRelationship = reader.uint64();
    } else {
      reader.skip(wire);
    }
  }

  return update;
}

function decodeTripUpdate(bytes: Uint8Array): TripUpdate {
  const reader = new ProtobufReader(bytes);
  const update: TripUpdate = {
    isDeleted: false,
    stopTimeUpdates: [],
  };

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      update.trip = decodeTrip(reader.bytesField());
    } else if (field === 2 && wire === 2) {
      update.stopTimeUpdates.push(decodeStopTimeUpdate(reader.bytesField()));
    } else if (field === 3 && wire === 2) {
      update.vehicleId = decodeVehicleDescriptor(reader.bytesField());
    } else if (field === 4 && wire === 0) {
      update.timestamp = reader.uint64();
    } else {
      reader.skip(wire);
    }
  }

  return update;
}

function decodeVehicle(bytes: Uint8Array): VehiclePosition {
  const reader = new ProtobufReader(bytes);
  const vehicle: VehiclePosition = {
    // FeedEntity.is_deleted defaults to false in the proto.
    isDeleted: false,
    // GTFS-Realtime declares IN_TRANSIT_TO (2) as the protobuf default.
    currentStatus: 2,
  };

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      vehicle.trip = decodeTrip(reader.bytesField());
    } else if (field === 2 && wire === 2) {
      Object.assign(vehicle, decodePosition(reader.bytesField()));
    } else if (field === 3 && wire === 0) {
      vehicle.currentStopSequence = reader.uint64();
    } else if (field === 4 && wire === 0) {
      vehicle.currentStatus = reader.uint64();
    } else if (field === 5 && wire === 0) {
      vehicle.timestamp = reader.uint64();
    } else if (field === 7 && wire === 2) {
      vehicle.stopId = reader.string() || undefined;
    } else if (field === 8 && wire === 2) {
      vehicle.vehicleId = decodeVehicleDescriptor(reader.bytesField());
    } else {
      reader.skip(wire);
    }
  }

  return vehicle;
}

interface DecodedEntity {
  tripUpdate?: TripUpdate;
  vehicle?: VehiclePosition;
}

function decodeEntity(bytes: Uint8Array): DecodedEntity {
  const reader = new ProtobufReader(bytes);
  let entityId: string | undefined;
  let isDeleted = false;
  let tripUpdate: TripUpdate | undefined;
  let vehicle: VehiclePosition | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      entityId = reader.string() || undefined;
    } else if (field === 2 && wire === 0) {
      isDeleted = reader.uint64() !== 0;
    } else if (field === 3 && wire === 2) {
      tripUpdate = decodeTripUpdate(reader.bytesField());
    } else if (field === 4 && wire === 2) {
      vehicle = decodeVehicle(reader.bytesField());
    } else {
      reader.skip(wire);
    }
  }

  if (vehicle) {
    vehicle.entityId = entityId;
    vehicle.isDeleted = isDeleted;
  }
  if (tripUpdate) {
    tripUpdate.entityId = entityId;
    tripUpdate.isDeleted = isDeleted;
  }
  return { tripUpdate, vehicle };
}

export function decodeFeedMessage(bytes: Uint8Array): FeedMessage {
  const reader = new ProtobufReader(bytes);
  const vehicles: VehiclePosition[] = [];
  const tripUpdates: TripUpdate[] = [];
  let headerTimestamp: number | undefined;
  let incrementality = 0;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const header = decodeHeader(reader.bytesField());
      headerTimestamp = header.timestamp;
      incrementality = header.incrementality;
    } else if (field === 2 && wire === 2) {
      const entity = decodeEntity(reader.bytesField());
      if (entity.vehicle) {
        vehicles.push(entity.vehicle);
      }
      if (entity.tripUpdate) {
        tripUpdates.push(entity.tripUpdate);
      }
    } else {
      reader.skip(wire);
    }
  }

  return { headerTimestamp, incrementality, vehicles, tripUpdates };
}
