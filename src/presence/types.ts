/**
 * Presence & collaboration wire types — canonical definitions live in
 * `@primebrick/core` (env-neutral, consumed by BE via this package and by the
 * FE via `@primebrick/ui`). This module re-exports them so the historical
 * `sdk/src/presence/types.js` path keeps working.
 */
export type {
  PresenceAction,
  PresenceStatus,
  PresenceSignal,
  PresenceEntry,
  EntityChangedMarker,
  PresenceSnapshot,
  PresenceDelta,
} from "@primebrick/core";
