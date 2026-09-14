import { afterEach, describe, expect, it, vi } from "vitest";
import { newClientUuid } from "../outbox";

/**
 * `crypto.randomUUID()` exists only on https and localhost. The factory stations reach
 * the server at a plain http LAN address, where it is undefined — and calling it threw
 * before any write left the screen, so weighings and payments failed silently.
 */
describe("newClientUuid", () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  afterEach(() => vi.unstubAllGlobals());

  it("produces a valid v4 uuid", () => {
    expect(newClientUuid()).toMatch(V4);
  });

  it("works where crypto.randomUUID does not exist — the insecure-origin case", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    expect((globalThis.crypto as Partial<Crypto>).randomUUID).toBeUndefined();
    expect(newClientUuid()).toMatch(V4);
  });

  it("still produces an id with no Web Crypto at all", () => {
    vi.stubGlobal("crypto", {});
    expect(newClientUuid()).toMatch(V4);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newClientUuid()));
    expect(seen.size).toBe(2000);
  });
});
