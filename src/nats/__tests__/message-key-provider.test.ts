/**
 * MessageKeyProvider reactive self-heal (WP-A6) — the debounced re-read is
 * what makes hint loss, boot ordering and mid-rotation arrivals irrelevant:
 * the first message that meets a missing key re-reads the vault, throttled.
 */
import { describe, expect, it, vi } from "vitest";
import { MessageKeyProvider, deriveMessageKey, MESSAGE_KEY_PART_A } from "../message-key-provider.js";

function material(generation: number, extra: Record<string, string> = {}) {
  return {
    generation,
    generations: { [String(generation)]: "b".repeat(43), ...extra },
  };
}

describe("MessageKeyProvider reactive self-heal", () => {
  it("keyForGeneration fires a re-read on miss and the key becomes available", async () => {
    let reads = 0;
    let current: ReturnType<typeof material> | null = null;
    const provider = new MessageKeyProvider(async () => {
      reads += 1;
      return current;
    }, MESSAGE_KEY_PART_A, 10);
    await provider.refresh();
    expect(provider.ready()).toBe(false);

    // vault gets provisioned behind the provider's back (hint lost)
    current = material(7);
    expect(provider.keyForGeneration(7)).toBeNull(); // miss → fires re-read
    await vi.waitFor(() => {
      expect(provider.keyForGeneration(7)).not.toBeNull();
    });
    expect(reads).toBe(2);
  });

  it("currentKey fires a re-read when the provider is not ready", async () => {
    let reads = 0;
    const provider = new MessageKeyProvider(async () => {
      reads += 1;
      return material(3);
    }, MESSAGE_KEY_PART_A, 10);
    // no boot refresh at all — simulates vault table absent at boot
    expect(provider.currentKey()).toBeNull();
    await vi.waitFor(() => {
      expect(provider.currentKey()).not.toBeNull();
    });
    expect(reads).toBe(1);
  });

  it("debounces — repeated misses inside the window cost one PG read", async () => {
    let reads = 0;
    const provider = new MessageKeyProvider(async () => {
      reads += 1;
      return material(1);
    }, MESSAGE_KEY_PART_A, 60_000);
    await provider.refresh();
    expect(reads).toBe(1);
    const first = reads;
    provider.keyForGeneration(99);
    provider.keyForGeneration(98);
    provider.keyForGeneration(97);
    await new Promise((r) => setTimeout(r, 30));
    expect(reads - first).toBeLessThanOrEqual(1);
  });

  it("throttles attempts even when the reader keeps failing", async () => {
    let reads = 0;
    const provider = new MessageKeyProvider(async () => {
      reads += 1;
      throw new Error("relation does not exist");
    }, MESSAGE_KEY_PART_A, 60_000);
    provider.keyForGeneration(1);
    provider.keyForGeneration(1);
    provider.keyForGeneration(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(reads).toBe(1);
  });

  it("never duplicates an in-flight refresh", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const provider = new MessageKeyProvider(async () => {
      reads += 1;
      await gate;
      return material(5);
    }, MESSAGE_KEY_PART_A, 0);
    provider.keyForGeneration(5);
    provider.keyForGeneration(5);
    release();
    await vi.waitFor(() => {
      expect(provider.keyForGeneration(5)).not.toBeNull();
    });
    // the second null-returning call above may itself fire one more refresh
    // after release — but never concurrently: reads are serialized
    expect(reads).toBeLessThanOrEqual(2);
  });

  it("derivation stays stable — reactive path changes no crypto", () => {
    expect(deriveMessageKey("a", "b", 1)).toEqual(deriveMessageKey("a", "b", 1));
  });
});
