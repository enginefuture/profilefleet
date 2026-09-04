/** @vitest-environment happy-dom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ProfileFleetClient } from "../client/client.js";
import {
  FleetOverview,
  ProfileFleetProvider,
  ProfileForm,
  ProfileTable,
} from "./index.js";

function response(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProfileFleet React", () => {
  test("renders capacity and profiles from the public HTTP client", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/profiles") return response([{
        id: "alpha",
        name: "Alpha",
        engine: "fake",
        fingerprintSeed: "alpha_seed",
        locale: "en-US",
        timezone: "UTC",
        headless: false,
        tags: ["test"],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }]);
      if (path === "/v1/sessions" || path === "/v1/leases") return response([]);
      if (path === "/v1/capacity") return response({ maximum: 2, active: 0, leased: 0, orphaned: 0, available: 2 });
      if (path === "/v1/events") return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
      return response({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    const client = new ProfileFleetClient({ baseUrl: "http://127.0.0.1:47110", token: "token", fetch: fetcher as typeof fetch });
    render(<ProfileFleetProvider client={client} pollIntervalMs={60_000}>
      <FleetOverview /><ProfileTable />
    </ProfileFleetProvider>);
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  test("submits a profile without undefined optional fields", async () => {
    let created: Record<string, unknown> | null = null;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/profiles" && init?.method === "POST") {
        created = JSON.parse(String(init.body));
        return response({
          ...created,
          id: "created",
          engine: "fake",
          fingerprintSeed: "generated_seed",
          locale: "en-US",
          timezone: "UTC",
          headless: false,
          tags: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }, 201);
      }
      if (path === "/v1/profiles") return response([]);
      if (path === "/v1/sessions" || path === "/v1/leases") return response([]);
      if (path === "/v1/capacity") return response({ maximum: 1, active: 0, leased: 0, orphaned: 0, available: 1 });
      if (path === "/v1/events") return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
      return response(undefined, 204);
    });
    const client = new ProfileFleetClient({ baseUrl: "http://127.0.0.1:47110", token: "token", fetch: fetcher as typeof fetch });
    render(<ProfileFleetProvider client={client} pollIntervalMs={60_000}><ProfileForm /></ProfileFleetProvider>);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Created profile" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(created).toMatchObject({ name: "Created profile", headless: false, tags: [] }));
    expect(created).not.toHaveProperty("proxyUrlEnv");
  });
});
