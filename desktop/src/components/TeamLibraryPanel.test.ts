import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "TeamLibraryPanel.tsx"), "utf8");

describe("TeamLibraryPanel sources", () => {
  it("opens on explicit import without requesting or displaying a community catalog", () => {
    expect(source).toContain('useState<TeamTab>("import")');
    expect(source).not.toContain('"explore"');
    expect(source).not.toContain("/api/team-library/catalog");
    expect(source).not.toContain("/api/team-library/teams/");
    expect(source).not.toContain("hezuobot-teams");
    expect(source).not.toContain("team-catalog");
    expect(source).not.toContain("ReadyBotGallery");
  });

  it("retains explicit URL, local file, organization imports and team creation", () => {
    expect(source).toContain('api("/api/team-library/github"');
    expect(source).toContain("url: requestedUrl.trim()");
    expect(source).toContain("void loadGithubUrl(initialUrl)");
    expect(source).toContain('previewManifest(teamImportPreview(manifest), "github")');
    expect(source).toContain('previewManifest(teamImportPreview(manifest), "file")');
    expect(source).toContain('api("/api/org-library")');
    expect(source).toContain('setTab("org")');
    expect(source).toContain("<OrgLibraryTab");
    expect(source).toContain("const createProject = async () =>");
    expect(source).toContain('setTab("scout")');
  });
});
