// Supported desktop-owner and solo Cloud banner behavior, without retired team identity.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

/** Small pictures a real encoder made, each carrying a camera make and model, a colour profile and text (EXIF, ICC, and a
 * comment or XMP or text chunks). */
const sample = (name: string) => readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url));
const JPEG_WITH_METADATA = sample("banner-metadata.jpg"), PNG_WITH_METADATA = sample("banner-metadata.png");

const BANNER = "/api/workspace/banner";

let fx: CloudSendFixture;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-banner-${randomBytes(8).toString("hex")}` });
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
}, hostTimeout(60_000));


/** A request as the desktop app's own page sends it to this computer's server: the window's session adds the owner's
 * header, and Chromium marks the page as the server's own. */
const ownPage = (path: string, init: RequestInit = {}) => fetch(`${fx.desktopBase}${path}`, { ...init, headers: { ...init.headers as Record<string, string>,
  "x-hezuo-desktop-owner": fx.ownerCapability, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
  ...(init.method && init.method !== "GET" ? { origin: fx.desktopBase } : {}) } });
const pictureOf = async (send: (path: string) => Promise<Response>) => ((await (await send("/api/config")).json()) as { workspaceBanner?: unknown }).workspaceBanner ?? null;

it("this computer's own page: the person is its owner, keeps a picture on this computer's own server, and Remove clears it", async () => {
  const session = (await (await ownPage("/api/auth/session")).json()) as { kind: string; scopes: string[]; trust?: string };
  expect([session.kind, session.trust, session.scopes.includes("admin")], "the app's own page is this server's owner (useOwnerOrAdmin: true)")
    .toEqual(["loopback", undefined, true]);
  expect(await pictureOf(ownPage), "plain until the person picks one").toBeNull();

  const saved = await ownPage(BANNER, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array(PNG_WITH_METADATA) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const kept = ((await saved.json()) as { banner: unknown }).banner;
  expect(await pictureOf(ownPage), "every page of this computer hears of it").toEqual(kept);
  const shown = await ownPage(BANNER);
  expect([shown.status, shown.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect(Buffer.from(await shown.arrayBuffer()).includes("Secret"), "checked again by this computer's server: no camera, author or profile").toBe(false);

  const browser = await fetch(`${fx.desktopBase}${BANNER}`, { method: "DELETE", headers: { "sec-fetch-site": "same-origin", origin: fx.desktopBase } });
  expect(browser.status, "a browser without the desktop capability cannot remove the banner").toBe(403);
  expect(await pictureOf(ownPage)).toEqual(kept);
  expect((await ownPage(BANNER, { method: "DELETE" })).status).toBe(200);
  expect(await pictureOf(ownPage), "Remove: plain again").toBeNull();
  expect((await ownPage(BANNER)).status).toBe(404);
}, hostTimeout(60_000));

it("a solo Cloud's owner changes My Cloud's picture, and Remove clears it", async () => {
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${fx.cloudBase}${path}`, { ...init,
    headers: { ...init.headers as Record<string, string>, ...fx.edge, authorization: `Bearer ${fx.owner}` } });
  const session = (await (await asOwner("/api/auth/session")).json()) as { kind: string; scopes: string[] };
  expect([session.kind, session.scopes.includes("admin")], "the owner's own session (useOwnerOrAdmin: true)").toEqual(["session", true]);
  const desktopBefore = await pictureOf(ownPage);
  const saved = await asOwner(BANNER, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(JPEG_WITH_METADATA) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  expect(await pictureOf(asOwner)).toEqual(((await saved.json()) as { banner: unknown }).banner);
  for (const [who, token] of [["signed out", null], ["a made-up token", "hezuo_not-a-session"]] as const) {
    const refused = await fx.asSession(token, "GET", BANNER);
    expect(refused.status, who).toBe(token === null ? 403 : 401);
    expect(refused.body, who).not.toHaveProperty("banner");
  }
  expect(await pictureOf(ownPage), "the Cloud-side write does not change the desktop banner").toEqual(desktopBefore);
  expect((await asOwner(BANNER, { method: "DELETE" })).status).toBe(200);
  expect(await pictureOf(asOwner)).toBeNull();
  expect(await pictureOf(ownPage), "the Cloud-side removal does not change the desktop banner").toEqual(desktopBefore);
}, hostTimeout(60_000));
