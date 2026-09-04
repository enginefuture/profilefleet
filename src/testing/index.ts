import { EventEmitter } from "node:events";
import type {
  BrowserEngineAdapter,
  EngineAdoptInput,
  EngineDoctorResult,
  EngineLaunchInput,
  EngineSessionHandle,
} from "../core/types.js";

interface FakeSession {
  alive: boolean;
  endpoint: string;
}

export interface FakeBrowserAdapterOptions {
  launchDelayMs?: number;
  failLaunch?: boolean;
}

export class FakeBrowserAdapter implements BrowserEngineAdapter {
  readonly id = "fake";
  readonly activity = new EventEmitter();
  readonly sessions = new Map<string, FakeSession>();

  constructor(private readonly options: FakeBrowserAdapterOptions = {}) {}

  async doctor(): Promise<EngineDoctorResult> {
    return {
      engine: this.id,
      ok: true,
      diagnostics: [{ name: "fake", ok: true, message: "Fake adapter ready" }],
    };
  }

  async launch(input: EngineLaunchInput): Promise<EngineSessionHandle> {
    if (this.options.launchDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.launchDelayMs));
    }
    if (this.options.failLaunch) throw new Error("Fake launch failure");
    const endpoint = `ws://127.0.0.1:${input.cdpPort}/devtools/browser/fake-${input.profile.id}`;
    const session = { alive: true, endpoint };
    this.sessions.set(input.profile.id, session);
    this.activity.emit("launch", input);
    return this.handle(input.profile.id, session);
  }

  async adopt(input: EngineAdoptInput): Promise<EngineSessionHandle> {
    const session = { alive: true, endpoint: input.cdpEndpoint };
    this.sessions.set(input.profile.id, session);
    this.activity.emit("adopt", input);
    return this.handle(input.profile.id, session);
  }

  fail(profileId: string): void {
    const session = this.sessions.get(profileId);
    if (session) session.alive = false;
  }

  private handle(profileId: string, session: FakeSession): EngineSessionHandle {
    return {
      pid: process.pid,
      cdpEndpoint: session.endpoint,
      isAlive: async () => session.alive,
      close: async () => {
        session.alive = false;
        this.sessions.delete(profileId);
        this.activity.emit("close", profileId);
      },
    };
  }
}
