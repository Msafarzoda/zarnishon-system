import { describe, expect, it } from "vitest";
import { dispositionFor } from "../outbox";

/**
 * One browser serves a whole shift. The weigher signs out, the cashier signs in, and the
 * offline queue is shared between them — so queued weighings were being sent under the
 * cashier's session, refused as the wrong role, and marked permanently rejected. Real
 * weighings were being destroyed by someone else logging in.
 */
describe("dispositionFor", () => {
  it("applies a success", () => {
    for (const status of [200, 201, 204]) {
      expect(dispositionFor(status), String(status)).toBe("applied");
    }
  });

  it("requeues when the wrong person is signed in, instead of destroying the work", () => {
    expect(dispositionFor(401)).toBe("requeue");
    expect(dispositionFor(403)).toBe("requeue");
  });

  it("rejects what the business refused on its merits — retrying will never help", () => {
    expect(dispositionFor(422)).toBe("rejected"); // already paid, tare above gross
    expect(dispositionFor(400)).toBe("rejected");
    expect(dispositionFor(404)).toBe("rejected");
  });

  it("requeues when the server is unwell rather than the operation", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(dispositionFor(status), String(status)).toBe("requeue");
    }
  });

  it("never silently drops an unexpected status", () => {
    for (const status of [0, 100, 302, 418, 599]) {
      expect(["applied", "requeue", "rejected"]).toContain(dispositionFor(status));
    }
  });
});
