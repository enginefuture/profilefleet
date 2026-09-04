import "./styles.css";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import {
  ProfileFleetClient,
  type ProfileFleetClientOptions,
} from "../client/client.js";
import type {
  BrowserLease,
  BrowserProfile,
  BrowserSession,
  CreateProfileInput,
  EngineDoctorResult,
  FleetCapacity,
  FleetEvent,
} from "../core/types.js";

interface FleetState {
  profiles: BrowserProfile[];
  sessions: BrowserSession[];
  leases: BrowserLease[];
  capacity: FleetCapacity | null;
  events: FleetEvent[];
  diagnostics: EngineDoctorResult[];
  loading: boolean;
  error: string | null;
}

interface FleetActions {
  refresh(): Promise<void>;
  createProfile(input: CreateProfileInput): Promise<BrowserProfile>;
  deleteProfile(id: string): Promise<void>;
  acquire(profileId: string): Promise<BrowserLease>;
  release(leaseId: string, stop?: boolean): Promise<void>;
  stopSession(sessionId: string, force?: boolean): Promise<void>;
  doctor(install?: boolean): Promise<EngineDoctorResult[]>;
}

interface FleetContextValue extends FleetState {
  client: ProfileFleetClient;
  actions: FleetActions;
}

const FleetContext = createContext<FleetContextValue | null>(null);

export interface ProfileFleetProviderProps extends PropsWithChildren {
  client?: ProfileFleetClient;
  clientOptions?: ProfileFleetClientOptions;
  pollIntervalMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProfileFleetProvider({
  children,
  client: suppliedClient,
  clientOptions,
  pollIntervalMs = 10_000,
}: ProfileFleetProviderProps) {
  const client = useMemo(
    () => suppliedClient ?? new ProfileFleetClient(clientOptions),
    [suppliedClient, clientOptions?.baseUrl, clientOptions?.token, clientOptions?.fetch],
  );
  const [state, setState] = useState<FleetState>({
    profiles: [],
    sessions: [],
    leases: [],
    capacity: null,
    events: [],
    diagnostics: [],
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const [profiles, sessions, leases, capacity] = await Promise.all([
        client.profiles.list(),
        client.sessions.list(),
        client.leases.list(),
        client.capacity.get(),
      ]);
      setState((current) => ({
        ...current,
        profiles,
        sessions,
        leases,
        capacity,
        loading: false,
        error: null,
      }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), pollIntervalMs);
    const controller = new AbortController();
    void client.subscribe((event) => {
      setState((current) => ({ ...current, events: [event, ...current.events].slice(0, 100) }));
      void refresh();
    }, {
      signal: controller.signal,
      onError: () => undefined,
    });
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [client, pollIntervalMs, refresh]);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    try {
      const result = await operation();
      await refresh();
      return result;
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error) }));
      throw error;
    }
  }, [refresh]);

  const actions = useMemo<FleetActions>(() => ({
    refresh,
    createProfile: (input) => run(() => client.profiles.create(input)),
    deleteProfile: (id) => run(() => client.profiles.delete(id)),
    acquire: (profileId) => run(() => client.leases.acquire({
      profileId,
      owner: "console",
      ttlSeconds: 600,
      requestId: `console-${profileId}`,
    })),
    release: (leaseId, stop = false) => run(() => client.leases.release(leaseId, { stop })),
    stopSession: (sessionId, force = false) => run(() => client.sessions.stop(sessionId, force)),
    doctor: async (install = false) => {
      const diagnostics = await run(() => client.engines.doctor(install));
      setState((current) => ({ ...current, diagnostics }));
      return diagnostics;
    },
  }), [client, refresh, run]);

  return <FleetContext.Provider value={{ ...state, client, actions }}>{children}</FleetContext.Provider>;
}

function useFleet(): FleetContextValue {
  const value = useContext(FleetContext);
  if (!value) throw new Error("ProfileFleet hooks must be used inside ProfileFleetProvider");
  return value;
}

export function useProfiles() {
  const { profiles, loading, error, actions } = useFleet();
  return { profiles, loading, error, create: actions.createProfile, delete: actions.deleteProfile, refresh: actions.refresh };
}

export function useSessions() {
  const { sessions, leases, loading, error, actions } = useFleet();
  return { sessions, leases, loading, error, acquire: actions.acquire, release: actions.release, stop: actions.stopSession };
}

export function useCapacity() {
  const { capacity, loading, error } = useFleet();
  return { capacity, loading, error };
}

export function useProfileActions(): FleetActions {
  return useFleet().actions;
}

export function useFleetEvents(): FleetEvent[] {
  return useFleet().events;
}

export function useEngineDiagnostics() {
  const { diagnostics, actions, error } = useFleet();
  return { diagnostics, doctor: actions.doctor, error };
}

export function FleetOverview() {
  const { capacity, loading } = useCapacity();
  const values = [
    ["Capacity", capacity?.maximum ?? "—"],
    ["Active", capacity?.active ?? "—"],
    ["Leased", capacity?.leased ?? "—"],
    ["Available", capacity?.available ?? "—"],
  ];
  return <section className="pf-card" aria-busy={loading}>
    <div className="pf-section-heading">
      <div><span className="pf-eyebrow">Fleet</span><h2>Runtime capacity</h2></div>
      <span className={`pf-status ${capacity?.available ? "pf-status--ok" : ""}`}>
        {loading ? "Checking" : capacity?.available ? "Ready" : "At capacity"}
      </span>
    </div>
    <div className="pf-metrics">
      {values.map(([label, value]) => <div className="pf-metric" key={label}>
        <span>{label}</span><strong>{value}</strong>
      </div>)}
    </div>
  </section>;
}

export interface ProfileTableProps {
  empty?: ReactNode;
}

export function ProfileTable({ empty }: ProfileTableProps) {
  const { profiles, loading, error, delete: remove } = useProfiles();
  const { sessions, leases, acquire, release } = useSessions();
  if (loading) return <div className="pf-empty">Loading profiles…</div>;
  if (error) return <div className="pf-alert" role="alert">{error}</div>;
  if (profiles.length === 0) return <>{empty ?? <div className="pf-empty">No profiles yet.</div>}</>;
  return <div className="pf-table-wrap"><table className="pf-table">
    <thead><tr><th>Profile</th><th>Identity</th><th>Status</th><th>Tags</th><th><span className="pf-sr-only">Actions</span></th></tr></thead>
    <tbody>{profiles.map((profile) => {
      const session = sessions.find((candidate) => candidate.profileId === profile.id);
      const lease = leases.find((candidate) => candidate.profileId === profile.id);
      return <tr key={profile.id}>
        <td><strong>{profile.name}</strong><small>{profile.id}</small></td>
        <td><code>{profile.fingerprintSeed.slice(0, 10)}…</code><small>{profile.locale} · {profile.timezone}</small></td>
        <td><span className={`pf-status ${session?.status === "running" ? "pf-status--ok" : ""}`}>{session?.status ?? "stopped"}</span></td>
        <td>{profile.tags.length ? profile.tags.join(", ") : "—"}</td>
        <td><div className="pf-actions">
          {lease
            ? <button className="pf-button pf-button--quiet" onClick={() => void release(lease.id, true)}>Stop</button>
            : <button className="pf-button" onClick={() => void acquire(profile.id)}>Start</button>}
          <button className="pf-button pf-button--danger" disabled={Boolean(session)} onClick={() => {
            if (window.confirm(`Delete profile “${profile.name}” and its local browser data?`)) void remove(profile.id);
          }}>Delete</button>
        </div></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

export function ProfileForm({ onCreated }: { onCreated?: (profile: BrowserProfile) => void }) {
  const { create } = useProfiles();
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSubmitting(true);
    try {
      const locale = String(form.get("locale") ?? "");
      const timezone = String(form.get("timezone") ?? "");
      const proxyUrlEnv = String(form.get("proxyUrlEnv") ?? "");
      const profile = await create({
        name: String(form.get("name") ?? ""),
        ...(locale ? { locale } : {}),
        ...(timezone ? { timezone } : {}),
        ...(proxyUrlEnv ? { proxyUrlEnv } : {}),
        headless: form.get("headless") === "on",
        tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      formElement.reset();
      onCreated?.(profile);
    } finally {
      setSubmitting(false);
    }
  };
  return <form className="pf-form" onSubmit={(event) => void submit(event)}>
    <label>Name<input required name="name" placeholder="Research account" /></label>
    <div className="pf-form-grid">
      <label>Locale<input name="locale" placeholder="en-US" /></label>
      <label>Timezone<input name="timezone" placeholder="America/New_York" /></label>
    </div>
    <label>Proxy environment variable<input name="proxyUrlEnv" pattern="[A-Z_][A-Z0-9_]*" placeholder="PROFILEFLEET_PROXY_RESEARCH" /></label>
    <label>Tags<input name="tags" placeholder="research, staging" /></label>
    <label className="pf-check"><input type="checkbox" name="headless" /> Run headless</label>
    <button className="pf-button" disabled={submitting}>{submitting ? "Creating…" : "Create profile"}</button>
  </form>;
}

export function SessionPanel() {
  const { sessions, leases, stop } = useSessions();
  return <section className="pf-card">
    <div className="pf-section-heading"><div><span className="pf-eyebrow">Runtime</span><h2>Sessions</h2></div></div>
    {sessions.length === 0 ? <div className="pf-empty">No active browser sessions.</div> : <ul className="pf-session-list">
      {sessions.map((session) => {
        const lease = leases.find((candidate) => candidate.sessionId === session.id);
        return <li key={session.id}>
          <div><strong>{session.profileId}</strong><small>{session.cdpEndpoint ?? `CDP ${session.cdpPort}`}</small></div>
          <div><span className="pf-status pf-status--ok">{session.status}</span><small>{lease ? `Lease until ${new Date(lease.expiresAt).toLocaleTimeString()}` : "Idle"}</small></div>
          <button className="pf-button pf-button--quiet" disabled={Boolean(lease)} onClick={() => void stop(session.id)}>Stop</button>
        </li>;
      })}
    </ul>}
  </section>;
}
