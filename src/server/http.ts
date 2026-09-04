import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ZodError } from "zod";
import { asFleetError, FleetError } from "../core/errors.js";
import {
  releaseLeaseSchema,
  renewLeaseSchema,
} from "../core/schemas.js";
import type {
  AcquireLeaseInput,
  CreateProfileInput,
  FleetEvent,
  UpdateProfileInput,
} from "../core/types.js";
import type { ProfileFleet } from "./fleet.js";

export interface ProfileFleetHttpOptions {
  fleet: ProfileFleet;
  token: string;
  allowedOrigins?: string[];
}

type AppEnv = { Variables: { requestId: string } };

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new FleetError("VALIDATION_ERROR", "Request body must be valid JSON");
  }
}

export function createProfileFleetApp(options: ProfileFleetHttpOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("x-request-id", requestId);
    c.set("requestId", requestId);
    const origin = c.req.header("origin");
    if (origin) {
      const requestOrigin = new URL(c.req.url).origin;
      if (origin !== requestOrigin && !allowedOrigins.has(origin)) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Origin is not allowed", requestId } }, 403);
      }
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id");
      c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    if (c.req.path.startsWith("/v1/") && c.req.path !== "/v1/health") {
      if (!bearerMatches(c.req.header("authorization"), options.token)) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "A valid bearer token is required", requestId } }, 401);
      }
    }
    await next();
  });

  app.get("/v1/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));
  app.get("/v1/capacity", (c) => c.json(options.fleet.capacity()));

  app.get("/v1/profiles", async (c) => c.json(await options.fleet.listProfiles()));
  app.post("/v1/profiles", async (c) => {
    const input = await jsonBody(c.req.raw) as CreateProfileInput;
    return c.json(await options.fleet.createProfile(input), 201);
  });
  app.get("/v1/profiles/:id", async (c) => c.json(await options.fleet.getProfile(c.req.param("id"))));
  app.patch("/v1/profiles/:id", async (c) => {
    const input = await jsonBody(c.req.raw) as UpdateProfileInput;
    return c.json(await options.fleet.updateProfile(c.req.param("id"), input));
  });
  app.delete("/v1/profiles/:id", async (c) => {
    await options.fleet.deleteProfile(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/v1/leases", (c) => c.json(options.fleet.listLeases()));
  app.post("/v1/leases", async (c) => {
    const input = await jsonBody(c.req.raw) as AcquireLeaseInput;
    return c.json(await options.fleet.acquire(input), 201);
  });
  app.post("/v1/leases/:id/renew", async (c) => {
    const input = renewLeaseSchema.parse(await jsonBody(c.req.raw));
    return c.json(await options.fleet.renewLease(c.req.param("id"), input.ttlSeconds));
  });
  app.delete("/v1/leases/:id", async (c) => {
    const raw = c.req.header("content-length") === "0" ? {} : await jsonBody(c.req.raw).catch(() => ({}));
    const input = releaseLeaseSchema.parse(raw);
    await options.fleet.releaseLease(c.req.param("id"), input);
    return c.body(null, 204);
  });

  app.get("/v1/sessions", (c) => c.json(options.fleet.listSessions()));
  app.post("/v1/sessions/:id/stop", async (c) => {
    const raw = await jsonBody(c.req.raw).catch(() => ({})) as { force?: unknown };
    await options.fleet.stopSession(c.req.param("id"), raw.force === true);
    return c.body(null, 204);
  });

  app.post("/v1/engines/doctor", async (c) => {
    return c.json(await options.fleet.doctor({ install: c.req.query("install") === "true" }));
  });

  app.get("/v1/events", (c) => streamSSE(c, async (stream) => {
    let ended = false;
    let eventNumber = 0;
    const writeEvent = (event: FleetEvent) => {
      if (ended) return;
      void stream.writeSSE({
        id: event.id,
        event: event.type,
        data: JSON.stringify(event),
      });
      eventNumber += 1;
    };
    const unsubscribe = options.fleet.subscribe(writeEvent);
    const keepAlive = setInterval(() => {
      if (!ended) void stream.writeSSE({ event: "keepalive", data: JSON.stringify({ eventNumber }) });
    }, 15_000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        ended = true;
        clearInterval(keepAlive);
        unsubscribe();
        resolve();
      });
    });
  }));

  app.onError((error, c) => {
    const requestId = c.get("requestId") as string | undefined;
    const fleetError = error instanceof ZodError
      ? new FleetError("VALIDATION_ERROR", error.issues.map((issue) => issue.message).join("; "))
      : asFleetError(error);
    return c.json({
      error: {
        code: fleetError.code,
        message: fleetError.message,
        ...(requestId ? { requestId } : {}),
      },
    }, fleetError.status as 400);
  });

  return app;
}
