/**
 * Query Redis server info (version) from a connected Redis client.
 *
 * Best-effort: returns null if the INFO call fails or the version cannot be parsed.
 * Used by the BE health endpoint and the startup banner to show the Redis server version.
 */

import type { RedisClientType } from "redis";

export type RedisInfo = {
  version: string;
};

/**
 * Query Redis INFO and parse the server version.
 *
 * The INFO command returns a text block with `\r\n` line separators:
 * ```
 * # Server\r\n
 * redis_version:7.4.0\r\n
 * redis_git_sha1:00000000\r\n
 * ...
 * ```
 *
 * @returns `{ version }` if the version was parsed, `null` if the INFO call failed or the version line was not found.
 */
export async function getRedisInfo(redis: RedisClientType): Promise<RedisInfo | null> {
  try {
    const info = (await redis.info()) as string;
    const match = info.match(/redis_version:([^\r\n]+)/);
    if (match) {
      return { version: match[1].trim() };
    }
    return null;
  } catch {
    return null;
  }
}
