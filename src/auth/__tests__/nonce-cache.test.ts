import { beforeEach, describe, expect, it } from "vitest";
import { isNonceReplay, resetNonceCacheForTest } from "../nonce-cache.js";

describe("nonce-cache (in-memory fallback)", () => {
  beforeEach(() => resetNonceCacheForTest());

  it("first sighting is not a replay, the repeat is", async () => {
    expect(await isNonceReplay("backend", "n-1")).toBe(false);
    expect(await isNonceReplay("backend", "n-1")).toBe(true);
  });

  it("distinct nonces and distinct services are independent", async () => {
    expect(await isNonceReplay("backend", "n-2")).toBe(false);
    expect(await isNonceReplay("backend", "n-3")).toBe(false);
    expect(await isNonceReplay("crm", "n-2")).toBe(false);
    expect(await isNonceReplay("crm", "n-2")).toBe(true);
  });
});
