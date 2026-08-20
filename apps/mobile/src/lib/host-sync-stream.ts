import { HostSyncEventSchema, type HostSyncEvent } from "codex-relay/api-schema";

export const hostSyncEventTypes: HostSyncEvent["type"][] = ["sync.required", "thread.changed"];

export function parseHostSyncStreamPayload(
  data: string,
  decodePayload: (payload: unknown) => unknown = identityPayload,
) {
  try {
    const parsed = HostSyncEventSchema.safeParse(decodePayload(JSON.parse(data)));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {}

  throw new Error("Codex Relay server returned an invalid host sync event.");
}

function identityPayload(payload: unknown) {
  return payload;
}
