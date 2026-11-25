/**
 * Message key provider — split-key derivation for fabric encryption (WP-A).
 *
 * Dual-control model: the encryption key requires TWO independent halves —
 *   parte_A = MESSAGE_KEY_PART_A, compile-time constant in this artifact (below)
 *   parte_B = rotating material in `system.config_entries` (PG), written by the
 *             BE RotatingSecretEngine and read by services ONLY via direct DAL —
 *             it NEVER transits on NATS (that circularity is what killed the
 *             original rotating-secret design).
 *
 *   enc_key(gen) = HMAC-SHA256(parte_A, parte_B_gen + ":" + gen) → 32 raw bytes
 *
 * A compromise of PG alone, the repo alone, or NATS storage alone yields
 * nothing — decryption requires all three domains.
 *
 * NOTE FOR POSTERITY — parte_A is TEMPORARILY hardcoded in this artifact.
 * Today any module can self-register into the platform, so the sdk artifact
 * itself is the only service-local trust boundary available. When module
 * certification lands (external authority — SPIFFE/cloud-attestation style),
 * each module will carry a SIGNED file attesting its identity; that file's
 * material is the ATTESTATION, and the fleet-wide bus key will be derived
 * post-attestation — not necessarily from this constant. Do not "clean up"
 * this constant without the certification mechanism in place: removing it
 * silently downgrades fabric encryption to single-control.
 */
import { createHmac } from "node:crypto";

/**
 * parte_A — fleet-common derivation root. See the posterity note above.
 * Not a credential: useless alone without live access to parte_B in PG.
 */
export const MESSAGE_KEY_PART_A = "pb-mkroot-v1:8f3c2a91e47b4d06f1a593c7d28b4e05a6c1f902d7b3485e96a0c3d51f2e7b89";

/** shape of the `service_message_key_material` row value in system.config_entries */
export interface MessageKeyMaterial {
  generation: number;
  /** generation number → base64url parte_B for that generation (trimmed to the key window) */
  generations: Record<string, string>;
}

export function deriveMessageKey(partA: string, partB: string, generation: number): Buffer {
  return createHmac("sha256", partA).update(`${partB}:${generation}`).digest();
}

/**
 * Reader port — implemented by createMicroservice wiring (A6) as a direct DAL
 * read on system.config_entries. Injectable for tests and for the boot order:
 * the provider never owns the connection, only the derivation and the cache.
 */
export type MessageKeyMaterialReader = () => Promise<MessageKeyMaterial | null>;

export class MessageKeyProvider {
  private keys = new Map<number, Buffer>();
  private currentGeneration: number | null = null;

  constructor(
    private readonly reader: MessageKeyMaterialReader,
    private readonly partA: string = MESSAGE_KEY_PART_A,
  ) {}

  /** Re-read the material row and re-derive the live generation window. */
  async refresh(): Promise<void> {
    const material = await this.reader();
    this.keys.clear();
    this.currentGeneration = null;
    if (!material) return;
    for (const [gen, partB] of Object.entries(material.generations ?? {})) {
      const g = Number(gen);
      if (Number.isFinite(g) && partB) this.keys.set(g, deriveMessageKey(this.partA, partB, g));
    }
    if (this.keys.has(material.generation)) this.currentGeneration = material.generation;
  }

  ready(): boolean {
    return this.currentGeneration !== null;
  }

  /** Publishers seal ONLY with the current generation. */
  currentKey(): { key: Buffer; generation: number } | null {
    if (this.currentGeneration === null) return null;
    const key = this.keys.get(this.currentGeneration);
    return key ? { key, generation: this.currentGeneration } : null;
  }

  /** Consumers open with whatever generation the message was sealed with —
   *  any generation inside the retained window (7-day cap, autowired). */
  keyForGeneration(generation: number): Buffer | null {
    return this.keys.get(generation) ?? null;
  }
}

let activeMessageKeyProvider: MessageKeyProvider | null = null;

export function setMessageKeyProvider(provider: MessageKeyProvider | null): void {
  activeMessageKeyProvider = provider;
}

export function getMessageKeyProvider(): MessageKeyProvider | null {
  return activeMessageKeyProvider;
}
