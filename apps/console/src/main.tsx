import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FleetOverview,
  ProfileFleetProvider,
  ProfileForm,
  ProfileTable,
  SessionPanel,
  useFleetEvents,
  useEngineDiagnostics,
} from "../../../src/react/index.js";
import "./styles.css";

function tokenFromLocation(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const incoming = fragment.get("token");
  if (incoming) {
    sessionStorage.setItem("profilefleet-token", incoming);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return incoming;
  }
  return sessionStorage.getItem("profilefleet-token") ?? "";
}

function EventLog() {
  const events = useFleetEvents();
  return <section className="console-events">
    <div className="console-heading"><div><span>Live stream</span><h2>Recent events</h2></div></div>
    {events.length === 0 ? <p>No events in this console session.</p> : <ol>
      {events.slice(0, 8).map((event) => <li key={event.id}>
        <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
        <strong>{event.type}</strong>
        <span>{event.profileId ?? "fleet"}</span>
      </li>)}
    </ol>}
  </section>;
}

function Diagnostics() {
  const { doctor, diagnostics } = useEngineDiagnostics();
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try { await doctor(false); } finally { setRunning(false); }
  };
  return <div className="console-doctor-wrap">
    <button className="console-doctor" onClick={() => void run()} disabled={running}>
      <span>Engine doctor</span><strong>{running ? "Checking…" : "Run diagnostics →"}</strong>
    </button>
    {diagnostics.length > 0 && <div className="console-diagnostics" role="status">
      {diagnostics.map((result) => <span key={result.engine}>{result.engine}: {result.ok ? "ready" : "needs attention"}</span>)}
    </div>}
  </div>;
}

function Console() {
  return <main className="console-shell">
    <header className="console-header">
      <a href="/" className="console-brand" aria-label="ProfileFleet home">
        <span className="console-mark">PF</span>
        <span><strong>ProfileFleet</strong><small>Local browser control plane</small></span>
      </a>
      <span className="console-local">127.0.0.1 · local only</span>
    </header>
    <div className="console-hero">
      <div><span className="console-kicker">One identity. One profile. One active lease.</span>
        <h1>Browser sessions,<br />kept coherent.</h1>
        <p>Persistent fingerprint profiles with explicit capacity, leases, recovery, and a small TypeScript surface.</p>
      </div>
      <Diagnostics />
    </div>
    <div className="console-grid">
      <FleetOverview />
      <section className="console-create">
        <div className="console-heading"><div><span>Identity</span><h2>Create profile</h2></div></div>
        <ProfileForm />
      </section>
    </div>
    <section className="console-section">
      <div className="console-heading"><div><span>Profiles</span><h2>Persistent identities</h2></div></div>
      <ProfileTable />
    </section>
    <div className="console-grid console-grid--bottom"><SessionPanel /><EventLog /></div>
    <footer>ProfileFleet v0.1.0 · Local-first · Apache-2.0</footer>
  </main>;
}

function LoginGate() {
  const [token, setToken] = useState(tokenFromLocation);
  if (!token) return <main className="console-gate">
    <form onSubmit={(event) => {
      event.preventDefault();
      const value = new FormData(event.currentTarget).get("token");
      if (typeof value === "string" && value.trim()) {
        sessionStorage.setItem("profilefleet-token", value.trim());
        setToken(value.trim());
      }
    }}>
      <span className="console-mark">PF</span><h1>Connect to the local fleet</h1>
      <p>Paste the token stored at <code>~/.profilefleet/token</code>. It stays in this tab only.</p>
      <label>Bearer token<input name="token" type="password" autoComplete="off" required /></label>
      <button>Connect</button>
    </form>
  </main>;
  return <ProfileFleetProvider clientOptions={{ baseUrl: location.origin, token }}><Console /></ProfileFleetProvider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><LoginGate /></StrictMode>);
