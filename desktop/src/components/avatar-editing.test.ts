import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { api } from "@/state/store";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "@/lib/bot-creation-draft";
import { botAvatarProfile } from "../../../packages/shared/bot-avatar";
import { AvatarFraming } from "./avatar-editing";
import { BotEditorContext } from "./bot-settings/BotEditorContext";

function renderFraming(draft: BotCreationDraft, preview: boolean) {
  return renderToStaticMarkup(createElement(
    BotEditorContext.Provider,
    { value: preview ? { request: draft.request, draft: true, uploadAvatar: draft.uploadAvatar } : { request: api } },
    createElement(AvatarFraming, { bot: draft.bot, disabled: false, onPatch: vi.fn() }),
  ));
}

describe("draft avatar framing", () => {
  it.each(["circle", "rounded", "square"] as const)("renders an uploaded draft blob with the %s crop only in the preview", async (avatarCrop) => {
    const url = "blob:http://localhost/draft-avatar";
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const network = vi.fn();
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn(), network as typeof api);
    try {
      const file = new File(["draft image"], "avatar.png", { type: "image/png" });
      const avatarUrl = await draft.uploadAvatar(file);
      draft.patch({ avatarUrl, avatarCrop, avatarZoom: 1.5, avatarFocusX: 0.25, avatarFocusY: 0.75 });

      const markup = renderFraming(draft, true);
      expect(createUrl).toHaveBeenCalledWith(file);
      expect(markup).toContain(`<img src="${url}"`);
      expect(markup).not.toContain("<svg");
      expect(markup).toContain("scale(1.5)");
      expect(markup).toContain("25% 75%");
      expect(markup).toContain("border-radius:" + ({ circle: "50%", rounded: "22%", square: "0" }[avatarCrop]));
      expect(markup).toContain('aria-label="Zoom avatar"');
      expect(renderFraming(draft, false)).not.toContain("<img");
      expect(botAvatarProfile(draft.bot).avatarUrl).toBeUndefined();
      expect(network).not.toHaveBeenCalled();
    } finally {
      draft.dispose();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });

  it("keeps rejecting remote URLs even in the draft preview", () => {
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn());
    draft.patch({ avatarUrl: "https://evil.example/tracker.svg", avatarCrop: "circle" });
    const markup = renderFraming(draft, true);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });

  it("revokes the replaced blob and releases the current blob on disposal", async () => {
    const firstUrl = "blob:http://localhost/first-avatar";
    const secondUrl = "blob:http://localhost/second-avatar";
    const createUrl = vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce(firstUrl).mockReturnValueOnce(secondUrl);
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn());
    try {
      const first = new File(["first"], "first.png", { type: "image/png" });
      const second = new File(["second"], "second.webp", { type: "image/webp" });
      expect(await draft.uploadAvatar(first)).toBe(firstUrl);
      expect(revokeUrl).not.toHaveBeenCalled();
      expect(await draft.uploadAvatar(second)).toBe(secondUrl);
      expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(firstUrl);
      expect(draft.avatarFile).toBe(second);
      draft.dispose();
      expect(revokeUrl.mock.calls).toEqual([[firstUrl], [secondUrl]]);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
});
