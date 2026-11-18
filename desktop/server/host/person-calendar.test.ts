import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "../connected-reads.ts";
import { busyTimes } from "./person-calendar.ts";

const H = 60 * 60_000;
const event = (start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e${start}`, title: "Salary review with HR", start, end, allDay: false, status: "confirmed", selfDeclined: false,
  attendees: [{ email: "hr@acme.test", self: false, organizer: true }], location: "Room 4", description: "Confidential", ...extra,
});

describe("busy times", () => {
  it("keeps only start and end, merges what touches, and leaves out declined, cancelled and day-long events", () => {
    const busy = busyTimes([
      event(10 * H, 11 * H), event(10.5 * H, 12 * H), event(12 * H, 13 * H), event(15 * H, 16 * H, { selfDeclined: true }),
      event(17 * H, 18 * H, { status: "cancelled" }), event(0, 24 * H, { allDay: true }), event(20 * H, 21 * H, { status: "tentative" }),
    ]);
    expect(busy).toEqual([{ start: 10 * H, end: 13 * H }, { start: 20 * H, end: 21 * H }]);
    expect(JSON.stringify(busy)).not.toMatch(/Salary|HR|Room|Confidential/);
  });
});
