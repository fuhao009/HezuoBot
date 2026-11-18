import { z } from "zod";

export class BrokerError extends Error {
  readonly status: number;
  readonly retryAfterS?: number;

  constructor(message: string, status: number, retryAfterS?: number) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }

  /** The service or the network failed; the same call can work later. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface BrokerTriggerType { slug: string; toolkit: string; name: string; description: string; instructions?: string; type?: string; config: Record<string, unknown>; payload: Record<string, unknown> }
const dropSchema = z.object({ count: z.number(), lastAt: z.number() });
const bindingSchema = z.object({
  triggerId: z.string(),
  slug: z.string(),
  toolkit: z.string(),
  connectedAccountId: z.string(),
  enabled: z.boolean(),
  remote: z.object({ state: z.enum(["enabled", "disabled", "missing"]), config: z.record(z.string(), z.unknown()).optional() }).nullable(),
  dropped: z.record(z.string(), dropSchema).default({}),
});
export interface BrokerInventory { triggers: Array<z.infer<typeof bindingSchema>>; unbound: Array<{ triggerId: string; enabled: boolean }> | null; remoteError?: string; limits: { plan: "desktop" | "cloud"; eventsPerDay: number }; usage: { eventsToday: number } }

const brokerEventSchema = z.object({
  seq: z.number(),
  id: z.string(),
  kind: z.enum(["message", "test", "trigger_disabled", "account_expired"]),
  triggerId: z.string().nullable(),
  receivedAt: z.number(),
  event: z.object({
    id: z.string().optional(),
    type: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
});
export type BrokerEvent = z.infer<typeof brokerEventSchema>;

export interface AppTriggerBroker {
  triggerTypes(apps: string[]): Promise<Record<string, { types?: BrokerTriggerType[]; error?: string }>>;
  triggerType(slug: string): Promise<BrokerTriggerType | null>;
  create(input: { slug: string; connectedAccountId: string; config: Record<string, unknown> }): Promise<{ triggerId: string }>;
  setEnabled(triggerId: string, enabled: boolean): Promise<void>;
  remove(triggerId: string): Promise<void>;
  inventory(): Promise<BrokerInventory>;
  poll(input: { after: number; waitS: number; poller: string; signal?: AbortSignal }): Promise<{ events: BrokerEvent[]; cursor: number }>;
  testEvent(triggerId: string, data: Record<string, unknown>): Promise<void>;
}

export function unavailableTriggerClient(): AppTriggerBroker {
  const unavailable = async (): Promise<never> => { throw new BrokerError("App events are unavailable without a supported event transport", 409); };
  return { triggerTypes: unavailable, triggerType: unavailable, create: unavailable, setEnabled: unavailable, remove: unavailable, inventory: unavailable, poll: unavailable, testEvent: unavailable };
}
