/**
 * Generic header reader abstraction — abstracts HTTP IncomingMessage and NATS Msg.
 *
 * This is the core of the framework-agnostic auth design: verifyAuth() reads
 * headers through this interface, so it works with raw HTTP, Express, and NATS
 * without any framework-specific code.
 */

import type { IncomingMessage } from "node:http";
import type { Msg } from "nats";
import { msgHeader } from "../nats/msg-headers.js";

export interface HeaderProvider {
  getHeader(name: string): string | undefined;
}

/** Adapter for raw Node.js HTTP IncomingMessage (microservices using createHttpServer). */
export class HttpHeaderProvider implements HeaderProvider {
  constructor(private req: IncomingMessage) {}

  getHeader(name: string): string | undefined {
    const val = this.req.headers[name.toLowerCase()];
    return Array.isArray(val) ? val[0] : val;
  }
}

/** Adapter for NATS Msg headers (NATS subscribers). */
export class NatsHeaderProvider implements HeaderProvider {
  constructor(private msg: Msg) {}

  getHeader(name: string): string | undefined {
    // MsgHdrs is case-sensitive — msgHeader tries the canonical form too.
    return msgHeader(this.msg.headers, name) ?? undefined;
  }
}
