import { ProfileFleetClient } from "profilefleet/client";
import { connectPlaywright } from "profilefleet/playwright";

const token = process.env.PROFILEFLEET_TOKEN;
if (!token) throw new Error("Set PROFILEFLEET_TOKEN before running this example");

const fleet = new ProfileFleetClient({ token });
const profiles = await fleet.profiles.list();
const profile = profiles[0] ?? await fleet.profiles.create({
  id: "example",
  name: "Example profile",
});
const managed = await fleet.acquireManaged({
  profileId: profile.id,
  owner: "node-example",
});

try {
  const browser = await connectPlaywright(managed.lease);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://example.com");
  console.log(await page.title());
} finally {
  await managed.release();
}
