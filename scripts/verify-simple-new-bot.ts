import { launchVerificationServer, runControlHezuo } from "./control-hezuo.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  await runControlHezuo(["new-bot", "--name", "Creation Atlas", "--url", fixture.info.url]);
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/simple-new-bot-preview.tsx",
    route: "/__simple-new-bot.html",
    title: "Isolated New Bot Verification",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
