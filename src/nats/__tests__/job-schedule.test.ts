import { describe, it, expect } from "vitest";
import { jobResultSubject } from "../job-contract.js";

describe("jobResultSubject", () => {
  it("peels the due lane off fired subjects", () => {
    expect(jobResultSubject("jobs.due.system.ai.partition-maintenance")).toBe("jobs.result.ai.partition-maintenance");
    expect(jobResultSubject("jobs.due.user.job.forward.abc")).toBe("jobs.result.job.forward.abc");
  });

  it("maps callable subjects verbatim", () => {
    expect(jobResultSubject("emailsender.send")).toBe("jobs.result.emailsender.send");
  });
});
