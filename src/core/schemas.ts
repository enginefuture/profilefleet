import { z } from "zod";

const safeId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const createProfileSchema = z.object({
  id: safeId.optional(),
  name: z.string().trim().min(1).max(120),
  engine: safeId.default("cloakbrowser"),
  fingerprintSeed: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  locale: z.string().trim().min(2).max(35).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  headless: z.boolean().optional(),
  proxyUrlEnv: envName.optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(32).optional(),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(32).optional(),
}).refine((input) => Object.keys(input).length > 0, "At least one field is required");

export const acquireLeaseSchema = z.object({
  profileId: safeId,
  owner: z.string().trim().min(1).max(120).default("client"),
  ttlSeconds: z.number().int().min(30).max(86_400).default(600),
  initialUrl: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "initialUrl must use HTTP or HTTPS").optional(),
  requestId: safeId.optional(),
});

export const renewLeaseSchema = z.object({
  ttlSeconds: z.number().int().min(30).max(86_400).default(600),
});

export const releaseLeaseSchema = z.object({
  stop: z.boolean().default(false),
});

export { envName, safeId };
