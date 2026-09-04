export type SessionStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "orphaned"
  | "error";

export interface BrowserProfile {
  id: string;
  name: string;
  engine: string;
  fingerprintSeed: string;
  locale: string;
  timezone: string;
  headless: boolean;
  proxyUrlEnv?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  firstLaunchedAt?: string;
}

export interface CreateProfileInput {
  id?: string;
  name: string;
  engine?: string;
  fingerprintSeed?: string;
  locale?: string;
  timezone?: string;
  headless?: boolean;
  proxyUrlEnv?: string;
  tags?: string[];
}

export interface UpdateProfileInput {
  name?: string;
  tags?: string[];
}

export interface BrowserSession {
  id: string;
  profileId: string;
  engine: string;
  status: SessionStatus;
  pid: number | null;
  cdpPort: number;
  cdpEndpoint: string | null;
  startedAt: string;
  lastSeenAt: string;
  error?: string;
}

export interface BrowserLease {
  id: string;
  sessionId: string;
  profileId: string;
  owner: string;
  expiresAt: string;
  cdpEndpoint: string;
  requestId?: string;
}

export interface AcquireLeaseInput {
  profileId: string;
  owner?: string;
  ttlSeconds?: number;
  initialUrl?: string;
  requestId?: string;
}

export interface ReleaseLeaseOptions {
  stop?: boolean;
}

export interface FleetCapacity {
  maximum: number;
  active: number;
  leased: number;
  orphaned: number;
  available: number;
}

export type FleetEventType =
  | "profile.created"
  | "profile.updated"
  | "profile.deleted"
  | "session.starting"
  | "session.running"
  | "session.stopping"
  | "session.stopped"
  | "session.orphaned"
  | "session.error"
  | "lease.acquired"
  | "lease.renewed"
  | "lease.released"
  | "lease.expired";

export interface FleetEvent {
  id: string;
  type: FleetEventType;
  timestamp: string;
  profileId?: string;
  sessionId?: string;
  leaseId?: string;
  detail?: Record<string, unknown>;
}

export interface EngineDiagnostic {
  name: string;
  ok: boolean;
  message: string;
}

export interface EngineDoctorResult {
  engine: string;
  ok: boolean;
  diagnostics: EngineDiagnostic[];
}

export interface EngineLaunchInput {
  profile: BrowserProfile;
  profileDir: string;
  cdpPort: number;
  proxyUrl?: string;
  initialUrl?: string;
}

export interface EngineAdoptInput {
  profile: BrowserProfile;
  profileDir: string;
  cdpPort: number;
  cdpEndpoint: string;
  browserPid: number | null;
}

export interface EngineSessionHandle {
  pid: number | null;
  cdpEndpoint: string;
  isAlive(): Promise<boolean>;
  close(): Promise<void>;
}

export interface BrowserEngineAdapter {
  readonly id: string;
  doctor(options?: { install?: boolean }): Promise<EngineDoctorResult>;
  launch(input: EngineLaunchInput): Promise<EngineSessionHandle>;
  adopt?(input: EngineAdoptInput): Promise<EngineSessionHandle>;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
