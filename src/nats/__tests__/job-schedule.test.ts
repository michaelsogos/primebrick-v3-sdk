import { describe, it, expect, beforeAll } from "vitest";
import { headers as natsHeaders, type Msg, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import {
  armJobSchedule,
  disarmJobSchedule,
  scheduleSubjectFor,
} from "../job-schedule.js";
import { jobResultSubject } from "../job-contract.js";
import { setCurrentServiceCode } from "../../service/service-identity.js";
import { extJsonStringify, extJsonParse } from "../../json/ext-json.js";

beforeAll(() => {
  // Deterministic namespace derivation — the slot mirrors what
  // createMicroservice() sets after resolveServiceCode().
  setCurrentServiceCode("ai");
});

/** Fake conn answering a request/reply with `replyPayload`, capturing the request. */
function replyConn(replyPayload: unknown) {
  let inboxSub: ((msg: Msg) => void) | null = null;
  const published: { subject: string; body: unknown; reply?: string }[] = [];
  const conn = {
    subscribe(subject: string): Subscription {
      let nextMsg: Msg | null = null;
      let waiter: ((m: Msg) => void) | null = null;
      if (subject.startsWith("_INBOX")) {
        inboxSub = (m) => (waiter ? waiter(m) : (nextMsg = m));
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const m = nextMsg ?? (await new Promise<Msg>((r) => (waiter = r)));
            nextMsg = null;
            waiter = null;
            yield m;
          }
        },
        unsubscribe: () => {},
      } as unknown as Subscription;
    },
    publish(subject: string, data: Uint8Array, opts?: { reply?: string }) {
      published.push({ subject, body: extJsonParse(new TextDecoder().decode(data)), reply: opts?.reply });
      setTimeout(() => {
        inboxSub?.({
          data: new TextEncoder().encode(extJsonStringify(replyPayload)),
          headers: natsHeaders(),
          reply: "",
        } as Msg);
      }, 0);
    },
  } as unknown as NatsConnection;
  return { conn, published };
}

describe("scheduleSubjectFor", () => {
  it("derives the caller namespace from the static service code", () => {
    expect(scheduleSubjectFor("partition-maintenance")).toBe("jobs.schedule.ai.partition-maintenance");
    expect(scheduleSubjectFor("sync.42")).toBe("jobs.schedule.ai.sync.42");
  });

  it("rejects names that are not subject-safe", () => {
    for (const bad of ["", "a b", "a>b", "a*b", ".a", "UPPER ok".replace(" ok", ""), "a/b"]) {
      expect(() => scheduleSubjectFor(bad)).toThrow("invalid job name");
    }
  });
});

describe("armJobSchedule", () => {
  it("requests on the ctl subject with the derived schedule_subject and resolves seq", async () => {
    const { conn, published } = replyConn({ armed: true, seq: "42" });
    const res = await armJobSchedule(
      { name: "partition-maintenance", schedule: "@every 1h", target: "jobs.due.system.ai.partition-maintenance", ttl: "7d" },
      { connection: conn },
    );
    expect(res.seq).toBe(42n);
    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe("jobs.ctl.schedule.request");
    expect(published[0].body).toEqual({
      schedule_subject: "jobs.schedule.ai.partition-maintenance",
      schedule: "@every 1h",
      target: "jobs.due.system.ai.partition-maintenance",
      ttl: "7d",
    });
  });

  it("propagates responder errors (foreign namespace, invalid spec, …)", async () => {
    const { conn } = replyConn({ error: { code: "FOREIGN_NAMESPACE", message: "nope" } });
    await expect(
      armJobSchedule({ name: "x", schedule: "bad", target: "jobs.due.system.ai.x" }, { connection: conn }),
    ).rejects.toThrow("FOREIGN_NAMESPACE");
  });
});

describe("disarmJobSchedule", () => {
  it("requests the cancel subject with the derived schedule_subject", async () => {
    const { conn, published } = replyConn({ disarmed: true });
    await disarmJobSchedule("partition-maintenance", { connection: conn });
    expect(published[0].subject).toBe("jobs.ctl.schedule.cancel");
    expect(published[0].body).toEqual({ schedule_subject: "jobs.schedule.ai.partition-maintenance" });
  });
});

describe("jobResultSubject", () => {
  it("peels the due lane off fired subjects", () => {
    expect(jobResultSubject("jobs.due.system.ai.partition-maintenance")).toBe("jobs.result.ai.partition-maintenance");
    expect(jobResultSubject("jobs.due.user.job.forward.abc")).toBe("jobs.result.job.forward.abc");
  });

  it("maps callable subjects verbatim", () => {
    expect(jobResultSubject("emailsender.send")).toBe("jobs.result.emailsender.send");
  });
});
