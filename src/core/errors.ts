export type FleetErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "PROFILE_IN_USE"
  | "CAPACITY_EXHAUSTED"
  | "ENGINE_UNAVAILABLE"
  | "LAUNCH_FAILED"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<FleetErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  PROFILE_IN_USE: 409,
  CONFLICT: 409,
  CAPACITY_EXHAUSTED: 429,
  LAUNCH_FAILED: 502,
  ENGINE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class FleetError extends Error {
  readonly code: FleetErrorCode;
  readonly status: number;

  constructor(code: FleetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FleetError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function asFleetError(error: unknown): FleetError {
  if (error instanceof FleetError) return error;
  if (error instanceof Error) {
    return new FleetError("INTERNAL_ERROR", error.message, { cause: error });
  }
  return new FleetError("INTERNAL_ERROR", "An unknown error occurred");
}
