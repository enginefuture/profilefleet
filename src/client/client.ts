import type {
  AcquireLeaseInput,
  ApiErrorPayload,
  BrowserLease,
  BrowserProfile,
  BrowserSession,
  CreateProfileInput,
  EngineDoctorResult,
  FleetCapacity,
  FleetEvent,
  ReleaseLeaseOptions,
  UpdateProfileInput,
} from "../core/types.js";
import { FleetError, type FleetErrorCode } from "../core/errors.js";

export interface ProfileFleetClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export interface EventSubscriptionOptions {
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

export interface ManagedLease {
  lease: BrowserLease;
  release(options?: ReleaseLeaseOptions): Promise<void>;
  stop(): Promise<void>;
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export class ProfileFleetClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly renewTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ProfileFleetClientOptions = {}) {
    this.baseUrl = trimBaseUrl(options.baseUrl ?? "http://127.0.0.1:47110");
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  readonly profiles = {
    list: () => this.request<BrowserProfile[]>("/v1/profiles"),
    get: (id: string) => this.request<BrowserProfile>(`/v1/profiles/${encodeURIComponent(id)}`),
    create: (input: CreateProfileInput) => this.request<BrowserProfile>("/v1/profiles", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    update: (id: string, input: UpdateProfileInput) => this.request<BrowserProfile>(
      `/v1/profiles/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
    delete: (id: string) => this.request<void>(`/v1/profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  };

  readonly leases = {
    list: () => this.request<BrowserLease[]>("/v1/leases"),
    acquire: (input: AcquireLeaseInput) => this.request<BrowserLease>("/v1/leases", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    renew: (id: string, ttlSeconds = 600) => this.request<BrowserLease>(
      `/v1/leases/${encodeURIComponent(id)}/renew`,
      { method: "POST", body: JSON.stringify({ ttlSeconds }) },
    ),
    release: (id: string, options: ReleaseLeaseOptions = {}) => this.request<void>(
      `/v1/leases/${encodeURIComponent(id)}`,
      { method: "DELETE", body: JSON.stringify(options) },
    ),
  };

  readonly sessions = {
    list: () => this.request<BrowserSession[]>("/v1/sessions"),
    stop: (id: string, force = false) => this.request<void>(
      `/v1/sessions/${encodeURIComponent(id)}/stop`,
      { method: "POST", body: JSON.stringify({ force }) },
    ),
  };

  readonly capacity = {
    get: () => this.request<FleetCapacity>("/v1/capacity"),
  };

  readonly engines = {
    doctor: (install = false) => this.request<EngineDoctorResult[]>(
      `/v1/engines/doctor${install ? "?install=true" : ""}`,
      { method: "POST" },
    ),
  };

  async acquireManaged(input: AcquireLeaseInput): Promise<ManagedLease> {
    const ttlSeconds = input.ttlSeconds ?? 600;
    let lease = await this.leases.acquire({ ...input, ttlSeconds });
    const renew = async () => {
      try {
        lease = await this.leases.renew(lease.id, ttlSeconds);
        schedule();
      } catch {
        this.renewTimers.delete(lease.id);
      }
    };
    const schedule = () => {
      const timer = setTimeout(() => void renew(), Math.max(15_000, ttlSeconds * 500));
      (timer as unknown as { unref?: () => void }).unref?.();
      this.renewTimers.set(lease.id, timer);
    };
    schedule();
    const release = async (options?: ReleaseLeaseOptions) => {
      const timer = this.renewTimers.get(lease.id);
      if (timer) clearTimeout(timer);
      this.renewTimers.delete(lease.id);
      await this.leases.release(lease.id, options);
    };
    return {
      get lease() { return lease; },
      release,
      stop: () => release({ stop: true }),
    };
  }

  async subscribe(
    listener: (event: FleetEvent) => void,
    options: EventSubscriptionOptions = {},
  ): Promise<void> {
    while (!options.signal?.aborted) {
      try {
        const response = await this.fetcher(`${this.baseUrl}/v1/events`, {
          headers: this.headers(),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok || !response.body) await this.throwResponseError(response);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (data) listener(JSON.parse(data) as FleetEvent);
          }
        }
      } catch (error) {
        if (!options.signal?.aborted) options.onError?.(error);
      }
      if (!options.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private headers(): HeadersInit {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init.headers },
    });
    if (!response.ok) await this.throwResponseError(response);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async throwResponseError(response: Response): Promise<never> {
    let payload: ApiErrorPayload | undefined;
    try {
      payload = await response.json() as ApiErrorPayload;
    } catch {
      // Preserve the HTTP error below.
    }
    const code = (payload?.error.code ?? "INTERNAL_ERROR") as FleetErrorCode;
    throw new FleetError(code, payload?.error.message ?? `ProfileFleet returned HTTP ${response.status}`);
  }
}

export function createProfileFleetClient(options?: ProfileFleetClientOptions): ProfileFleetClient {
  return new ProfileFleetClient(options);
}
