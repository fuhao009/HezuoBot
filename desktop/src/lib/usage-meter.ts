export type MeterBand = "ok" | "near" | "full";

export function meterBand(percent: number): MeterBand {
  return percent >= 100 ? "full" : percent >= 80 ? "near" : "ok";
}
