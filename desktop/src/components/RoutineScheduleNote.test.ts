import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { schedulePlace } from "./RoutineScheduleNote";

it("identifies where the existing schedule runs", () => {
  expect(schedulePlace({ cloudHome: true, local: false })).toEqual({ kind: "cloud" });
  expect(schedulePlace({ cloudHome: false, local: false })).toEqual({ kind: "server" });
  expect(schedulePlace({ cloudHome: false, local: true })).toEqual({ kind: "local" });
});

it("keeps schedule guidance without plan subscriptions, purchase or workspace switching", () => {
  const source = readFileSync(new URL("./RoutineScheduleNote.tsx", import.meta.url), "utf8");
  expect(source).toContain("routines.scheduleNote.local");
  expect(source).toContain("routines.scheduleNote.server");
  expect(source).toContain("routines.scheduleNote.cloud");
  for (const removed of ["openCloudAdd", "connectHome", "useCloudPlan", "<button"]) expect(source).not.toContain(removed);
});
