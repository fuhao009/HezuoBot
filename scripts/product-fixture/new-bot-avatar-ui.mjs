import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// Generated locally, not a downloaded avatar: a small opaque two-colour PNG.
function fixturePng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const offset = y * 65 + 1 + x * 4;
    pixels.set(x < 8 ? [240, 70, 30, 255] : [30, 90, 220, 255], offset);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

// Read only rendered avatar nodes, never renderer stores or React internals.
const observeAvatar = (root, name, preview = false) => `(() => {
  const root = document.querySelector(${JSON.stringify(root)});
  const nodes = [...(root?.querySelectorAll('svg[role="img"], img') ?? [])];
  const node = nodes.find(node => node.getAttribute('aria-label') === ${JSON.stringify(name)} ||
    node.getAttribute('alt') === ${JSON.stringify(`${name} avatar`)} || node.getAttribute('alt') === ${JSON.stringify(name)} ||
    (${JSON.stringify(preview)} && node.getAttribute('alt') === ${JSON.stringify(`${name} avatar preview`)}));
  if (!node || !node.getBoundingClientRect().width || !node.getBoundingClientRect().height) return null;
  if (node.tagName.toLowerCase() === 'img') return { kind: 'image', src: node.src,
    loaded: node.complete && node.naturalWidth > 0, width: node.naturalWidth, height: node.naturalHeight };
  return { kind: 'mascot', stops: [...node.querySelectorAll('linearGradient stop')].map(stop => getComputedStyle(stop).stopColor),
    silhouette: node.querySelector('clipPath')?.innerHTML ?? null };
})()`;

export async function verifyNewBotAvatars({ page, openNewBot, snapshot, profileFile, root, capture, evidence }) {
  const dialog = '[role="dialog"][aria-label="New Bot"]';
  const diagnosePreview = async (name) => {
    const failure = evidence.draftPreviewFailure = { name };
    const diagnostics = await Promise.allSettled([
      page.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(dialog)});
        return { outerHTML: root?.outerHTML ?? null,
          avatars: [...(root?.querySelectorAll('svg[role="img"], img') ?? [])].map(node => {
            const bounds = node.getBoundingClientRect();
            return { tag: node.tagName, label: node.getAttribute('aria-label'), alt: node.getAttribute('alt'),
              src: node.getAttribute('src'), complete: node.complete, naturalWidth: node.naturalWidth,
              naturalHeight: node.naturalHeight, width: bounds.width, height: bounds.height };
          }) };
      })()`),
      capture(page, "12c-avatar-draft-preview-failure"),
    ]);
    for (const [index, key] of ["dom", "screenshot"].entries()) {
      const result = diagnostics[index];
      if (result.status === "fulfilled") failure[key] = result.value;
      else failure[`${key}Error`] = String(result.reason);
    }
  };
  const draft = async () => {
    const fields = await page.evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(dialog)});
      return { name: dialog.querySelector('[data-new-bot-name]').value,
        color: dialog.querySelector('[aria-label$=" mascot color"][aria-pressed="true"]')?.getAttribute('aria-label'),
        soul: dialog.querySelector('[data-new-bot-soul]').value };
    })()`);
    assert.ok(fields.name.trim(), "avatar acceptance: prefilled name exists");
    fields.avatar = await page.evaluate(observeAvatar(dialog, fields.name, true));
    if (!fields.avatar) await diagnosePreview(fields.name);
    assert.ok(fields.avatar, "avatar acceptance: draft preview exists");
    return fields;
  };
  const save = async (before, expected, caseEvidence) => {
    await page.click("avatar acceptance: Create", "document.querySelector('[data-new-bot-create]')");
    await page.until(`!document.querySelector(${JSON.stringify(dialog)})`, { label: "avatar creation completes", timeoutMs: 30_000 });
    const after = await snapshot();
    const added = after.filter(bot => !before.some(previous => previous.id === bot.id));
    assert.equal(after.length, before.length + 1);
    assert.equal(added.length, 1);
    const bot = added[0];
    assert.equal(bot.name, expected.name);
    assert.equal(bot.soul ?? "", expected.soul);
    const saved = JSON.parse(readFileSync(profileFile, "utf8")).find(item => item.id === bot.id);
    assert.ok(saved, "avatar acceptance: bot persisted");
    for (const key of ["name", "soul", "color", "avatarUrl", "avatarCrop", "mascotBody", "mascotFaceColor"]) {
      if (key === "avatarUrl" && saved[key] == null && bot[key] == null) {
        // The profile omits an absent image; the API may serialize it as null.
        assert.equal(saved[key] ?? null, bot[key] ?? null, "avatar acceptance: both avatar URLs absent");
      } else {
        assert.deepEqual(saved[key], bot[key], `avatar acceptance: persisted ${key} matches API`);
      }
    }
    const sidebar = `[data-sidebar-bot-row="${bot.id}"]`;
    await page.until(`Boolean(document.querySelector(${JSON.stringify(`${sidebar}[aria-current="page"]`)}))`, { label: "new avatar bot selected" });
    const expressions = { sidebar: observeAvatar(sidebar, bot.name), chat: observeAvatar('[data-product-chat]', bot.name) };
    Object.assign(caseEvidence, { api: bot, persisted: saved,
      avatarSelectors: { sidebar, chat: '[data-product-chat]', name: bot.name }, rendered: {} });
    const rendered = {};
    for (const [place, expression] of Object.entries(expressions)) {
      rendered[place] = await page.untilValue(`(() => { const avatar = (${expression}); return avatar && (avatar.kind !== 'image' || avatar.loaded) ? avatar : null; })()`, { label: `${place} avatar rendered`, timeoutMs: 15_000 });
      caseEvidence.rendered[place] = rendered[place];
      assert.equal(rendered[place].kind, expected.avatar.kind);
      if (expected.avatar.kind === "mascot") {
        if (caseEvidence.colorConsistency?.status !== "excludedByUser") {
          assert.deepEqual(rendered[place].stops, expected.avatar.stops, `${place}: chosen gradient rendered`);
        }
        assert.equal(rendered[place].silhouette, expected.avatar.silhouette, `${place}: chosen silhouette rendered`);
      } else {
        assert.equal(rendered[place].src, new URL(bot.avatarUrl, page.target.url).href, `${place}: saved image rendered`);
        if (!expected.avatar.src.startsWith("blob:")) assert.equal(rendered[place].src, expected.avatar.src, `${place}: unchanged default image`);
      }
    }
    return { api: bot, persisted: saved, rendered };
  };

  // Each case opens a fresh draft. No field writes at all in the first case.
  const defaults = evidence.untouchedDefaults = {
    colorConsistency: {
      status: "excludedByUser",
      reason: "用户排除头像颜色一致性验收；保留默认创建、持久化/API 一致性及两处渲染观察。",
    },
    nonColorChecks: { passed: false },
  };
  let before = await snapshot();
  await openNewBot();
  defaults.prefilled = await draft();
  defaults.draftScreenshot = await capture(page, "12c-avatar-default-draft");
  Object.assign(defaults, await save(before, defaults.prefilled, defaults));
  defaults.createdScreenshot = await capture(page, "12c-avatar-default-created");
  defaults.nonColorChecks.passed = true;

  evidence.selectedColor = {
    status: "excludedByUser",
    reason: "显式改色场景属于用户排除的颜色验收范围，不执行改色操作或颜色断言。",
  };

  const uploaded = evidence.uploadedPng = { passed: false, method: "CDP DOM.setFileInputFiles on the dialog's real file input; normal app save/upload" };
  before = await snapshot();
  await openNewBot();
  uploaded.initial = await draft();
  const bytes = fixturePng();
  const file = join(root, "avatar-acceptance.png");
  writeFileSync(file, bytes);
  uploaded.fixture = { file, bytes: bytes.length, width: 16, height: 16 };
  const { root: documentNode } = await page.connection.send("DOM.getDocument");
  const { nodeId } = await page.connection.send("DOM.querySelector", { nodeId: documentNode.nodeId, selector: `${dialog} input[type="file"]` });
  assert.ok(nodeId, "real avatar file input exists");
  await page.connection.send("DOM.setFileInputFiles", { nodeId, files: [file] });
  try {
    await page.untilValue(`(() => { const value = (${observeAvatar(dialog, uploaded.initial.name, true)}); return value?.kind === 'image' && value.loaded; })()`, { label: "file input PNG preview", timeoutMs: 15_000 });
  } catch (error) {
    await diagnosePreview(uploaded.initial.name);
    throw error;
  }
  uploaded.chosen = await draft();
  assert.equal(uploaded.chosen.avatar.kind, "image");
  uploaded.draftScreenshot = await capture(page, "12c-avatar-upload-draft");
  Object.assign(uploaded, await save(before, uploaded.chosen, uploaded));
  assert.ok(uploaded.api.avatarUrl && !/^(blob:|data:)/.test(uploaded.api.avatarUrl), "saved avatar uses a persistent URL");
  const savedBytes = await page.evaluate(`fetch(${JSON.stringify(uploaded.api.avatarUrl)}).then(async response => {
    if (!response.ok) throw new Error('saved avatar HTTP ' + response.status);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  })`);
  assert.deepEqual(Buffer.from(savedBytes), bytes, "saved avatar resource is the exact file selected by the input");
  uploaded.resourceBytesVerified = true;
  uploaded.createdScreenshot = await capture(page, "12c-avatar-upload-created");
  uploaded.passed = true;
}
