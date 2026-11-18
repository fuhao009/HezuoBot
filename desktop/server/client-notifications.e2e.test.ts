import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("keeps admin spend alerts hidden and unread when a locally paired client reads a conversation", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-spend-read-token" });
  try {
    const client = await fixture.pairLocal("notification reader", ["client"]);
    const created = await fixture.onCloud("POST", "/api/bots", { name: "Scout" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const channel = await fixture.onCloud("POST", "/api/groups", { name: "Updates", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(channel.status).toBe(201);
    const group = channel.body.group;
    const db = new DatabaseSync(join(fixture.root, "cloud", ".hezuo", "messages.db"));
    try {
      const insert = db.prepare("INSERT INTO notification_log(id, at, kind, bot_id, bot_name, thread_id, title, body) VALUES (?, ?, 'spend', ?, 'Scout', ?, 'Fixture spend', '$12 of $20 spent')");
      insert.run("shared-spend", Date.now(), bot.id, bot.mainThreadId);
      insert.run("workspace-spend", Date.now(), bot.id, "");
      const unread = () => db.prepare("SELECT id FROM notification_log WHERE read = 0 AND id IN ('shared-spend', 'workspace-spend') ORDER BY id").all().map((row) => row.id);
      for (const [path, threadId] of [
        [`/api/bots/${bot.id}/read`, bot.mainThreadId],
        [`/api/bots/${bot.id}/tasks/${bot.mainThreadId}`, bot.mainThreadId],
        [`/api/groups/${group.id}/read`, group.threadId],
        [`/api/groups/${group.id}/tasks/${group.threadId}`, group.threadId],
      ]) {
        db.prepare("UPDATE notification_log SET read = 0 WHERE id IN ('shared-spend', 'workspace-spend')").run();
        db.prepare("UPDATE notification_log SET thread_id = ? WHERE id = 'shared-spend'").run(threadId);
        const listed = await fixture.asSession(client, "GET", "/api/notifications");
        expect(listed.status).toBe(200);
        expect(listed.body.notifications.map((entry: { id: string }) => entry.id)).not.toContain("shared-spend");
        expect((await fixture.asSession(client, "POST", "/api/notifications/shared-spend/read")).status).toBe(404);
        expect((await fixture.asSession(client, "POST", "/api/notifications/read-all")).status).toBe(200);
        expect(unread()).toEqual(["shared-spend", "workspace-spend"]);
        expect((await fixture.asSession(client, "POST", path, { threadId })).status, path).toBe(200);
        expect(unread(), path).toEqual(["shared-spend", "workspace-spend"]);
        expect((await fixture.onCloud("POST", path, { threadId })).status, path).toBe(200);
        expect(unread(), path).toEqual(["workspace-spend"]);
      }
    } finally {
      db.close();
    }
  } finally {
    await fixture.close();
  }
}, hostTimeout(120_000));
