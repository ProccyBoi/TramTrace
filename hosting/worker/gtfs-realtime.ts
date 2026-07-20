/**
 * Minimal, dependency-free GTFS-Realtime decoder.
 *
 * TfNSW's vehicle-position endpoints return standard GTFS-Realtime protobufs.
 * TramTrace only needs FeedHeader.timestamp and the VehiclePosition subset, so
 * decoding those fields directly keeps the deployed Worker small and avoids a
 * Node-specific protobuf runtime.
 */

export interface TripDescriptor {
  tripId?: string;
  startTime?: string;
  startDate?: string;
  routeId?: string;
  directionId?: number;
}

export interface VehiclePosition {
  entityId?: string;
  vehicleId?: string;
  trip?: TripDescriptor;
  stopId?: string;
  currentStopSequence?: number;
  currentStatus: number;
  latitude?: number;
  longitude?: number;
  timestamp?: number;
}

export interface FeedMessage {
  headerTimestamp?: number;
  vehicles: VehiclePosition[];
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
        this.uint64();
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
}

function decodeHeader(bytes: Uint8Array): number | undefined {
  const reader = new ProtobufReader(bytes);
  let timestamp: number | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 3 && wire === 0) {
      timestamp = reader.uint64();
    } else {
      reader.skip(wire);
    }
  }

  return timestamp;
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

function decodeVehicle(bytes: Uint8Array): VehiclePosition {
  const reader = new ProtobufReader(bytes);
  const vehicle: VehiclePosition = {
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

function decodeEntity(bytes: Uint8Array): VehiclePosition | undefined {
  const reader = new ProtobufReader(bytes);
  let entityId: string | undefined;
  let vehicle: VehiclePosition | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      entityId = reader.string() || undefined;
    } else if (field === 4 && wire === 2) {
      vehicle = decodeVehicle(reader.bytesField());
    } else {
      reader.skip(wire);
    }
  }

  if (vehicle) {
    vehicle.entityId = entityId;
  }
  return vehicle;
}

export function decodeFeedMessage(bytes: Uint8Array): FeedMessage {
  const reader = new ProtobufReader(bytes);
  const vehicles: VehiclePosition[] = [];
  let headerTimestamp: number | undefined;

  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      headerTimestamp = decodeHeader(reader.bytesField());
    } else if (field === 2 && wire === 2) {
      const vehicle = decodeEntity(reader.bytesField());
      if (vehicle) {
        vehicles.push(vehicle);
      }
    } else {
      reader.skip(wire);
    }
  }

  return { headerTimestamp, vehicles };
}
