import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RETRIES, DEFAULT_RETRY_DELAY_MS, DEFAULT_TIMEOUT_MS, NetworkError, Precleared, ServerError, ValidationError } from "../src/index";

import { OK_PAYLOAD } from "./fixtures";
import { hanging, jsonResponse, makeClient, MockFetch, routed, sequence, unreachable } from "./helpers";

const INPUT = { recipient_email: "jane@acme.co.uk" };

afterEach(() => {
  vi.useRealTimers();
});

describe("retries", () => {
  it("defaults to one retry after a short pause and a 20 second timeout", () => {
    expect(DEFAULT_RETRIES).toBe(1);
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
    expect(DEFAULT_RETRY_DELAY_MS).toBe(300);
    const client = new Precleared({ fetch: new MockFetch().fetch });
    expect(client.retries).toBe(1);
    expect(client.timeoutMs).toBe(20_000);
    expect(client.retryDelayMs).toBe(300);
  });

  it("retries once after a 5xx and returns the second answer", async () => {
    const handler = routed({ check: sequence(jsonResponse(503, { error: "server_error" }), jsonResponse(200, OK_PAYLOAD)) });
    const { client, mock } = makeClient(handler);
    const result = await client.check(INPUT);
    expect(result.verdict).toBe("ok_to_email");
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]?.body).toBe(mock.requests[1]?.body);
  });

  it("gives up after the retry when the 5xx persists", async () => {
    const { client, mock } = makeClient(routed({ check: jsonResponse(502, { error: "server_error", message: "down" }) }));
    await expect(client.check(INPUT)).rejects.toThrow(ServerError);
    expect(mock.requests).toHaveLength(2);
  });

  it("retries once after a network error", async () => {
    const handler = routed({ check: sequence(unreachable, jsonResponse(200, OK_PAYLOAD)) });
    const { client, mock } = makeClient(handler);
    await expect(client.check(INPUT)).resolves.toMatchObject({ verdict: "ok_to_email" });
    expect(mock.requests).toHaveLength(2);
  });

  it("throws NetworkError when the network error persists", async () => {
    const { client, mock } = makeClient(routed({ check: unreachable }));
    await expect(client.check(INPUT)).rejects.toThrow(NetworkError);
    expect(mock.requests).toHaveLength(2);
  });

  it.each([400, 401, 402, 404, 429])("never retries a %s", async (status) => {
    const { client, mock } = makeClient(routed({ check: jsonResponse(status, { error: "nope" }) }));
    await expect(client.check(INPUT)).rejects.toBeInstanceOf(Error);
    expect(mock.requests).toHaveLength(1);
  });

  it("honours retries: 0 and a higher count", async () => {
    const none = makeClient(routed({ check: jsonResponse(500, {}) }), { retries: 0 });
    await expect(none.client.check(INPUT)).rejects.toThrow(ServerError);
    expect(none.mock.requests).toHaveLength(1);

    const three = makeClient(routed({ check: jsonResponse(500, {}) }), { retries: 3 });
    await expect(three.client.check(INPUT)).rejects.toThrow(ServerError);
    expect(three.mock.requests).toHaveLength(4);
  });

  it("waits retryDelayMs between attempts", async () => {
    vi.useFakeTimers();
    const handler = routed({ check: sequence(jsonResponse(500, {}), jsonResponse(200, OK_PAYLOAD)) });
    const { client, mock } = makeClient(handler, { retryDelayMs: 300 });

    const pending = client.check(INPUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(mock.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.requests).toHaveLength(2);
    await expect(pending).resolves.toMatchObject({ verdict: "ok_to_email" });
  });

  it("retries the receipt and health calls too", async () => {
    const { client, mock } = makeClient(
      routed({
        receipt: sequence(unreachable, routed()),
        health: sequence(jsonResponse(500, {}), routed()),
      }),
    );
    await expect(client.getReceipt("cc_rcpt_4M460J4JCZVFQQTZ")).resolves.toMatchObject({ id: "cc_rcpt_4M460J4JCZVFQQTZ" });
    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
    expect(mock.requests).toHaveLength(4);
  });
});

describe("timeouts", () => {
  it("aborts a hanging request after timeoutMs and reports a timeout", async () => {
    vi.useFakeTimers();
    const { client, mock } = makeClient(routed({ check: hanging }), { retries: 0 });

    const pending = client.check(INPUT);
    const settled = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(mock.last.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.last.signal?.aborted).toBe(true);

    const error = await settled;
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).code).toBe("timeout");
    expect((error as NetworkError).message).toBe("Precleared did not respond within 20000 ms.");
    expect(((error as NetworkError).cause as Error).name).toBe("AbortError");
  });

  it("uses the client timeout, and a per-request override", async () => {
    vi.useFakeTimers();
    const { client, mock } = makeClient(routed({ check: hanging }), { retries: 0, timeoutMs: 5_000 });

    const first = client.check(INPUT).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await first) as NetworkError).toMatchObject({ code: "timeout" });

    const second = client.check(INPUT, { timeoutMs: 1_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(mock.last.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second) as NetworkError).toMatchObject({ code: "timeout", message: "Precleared did not respond within 1000 ms." });
  });

  it("retries once after a timeout, then fails", async () => {
    vi.useFakeTimers();
    const { client, mock } = makeClient(routed({ check: hanging }), { timeoutMs: 1_000, retryDelayMs: 300 });

    let settled = false;
    const pending = client.check(INPUT).catch((error: unknown) => error).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(mock.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // first attempt times out at 1000 ms
    expect(mock.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300); // retry after the pause
    expect(mock.requests).toHaveLength(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); // second attempt times out too
    expect((await pending) as NetworkError).toMatchObject({ code: "timeout" });
    expect(mock.requests).toHaveLength(2);
  });

  it("succeeds when the retry answers in time", async () => {
    vi.useFakeTimers();
    const handler = routed({ check: sequence(hanging, jsonResponse(200, OK_PAYLOAD)) });
    const { client, mock } = makeClient(handler, { timeoutMs: 1_000 });

    const pending = client.check(INPUT);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ verdict: "ok_to_email" });
    expect(mock.requests).toHaveLength(2);
  });

  it("clears the timer when the response arrives", async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    await client.check(INPUT);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("caller abort", () => {
  it("throws the caller's abort reason and does not retry", async () => {
    const controller = new AbortController();
    const { client, mock } = makeClient(routed({ check: hanging }));

    const pending = client.check(INPUT, { signal: controller.signal }).catch((error: unknown) => error);
    await Promise.resolve();
    const reason = new Error("user cancelled");
    controller.abort(reason);
    const error = await pending;
    expect(error).toBe(reason);
    expect(mock.requests).toHaveLength(1);
    expect(mock.last.signal?.aborted).toBe(true);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, mock } = makeClient();
    const error = await client.check(INPUT, { signal: controller.signal }).catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
    expect(mock.requests).toHaveLength(0);
  });

  it("validation still runs before the signal is consulted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = makeClient();
    await expect(client.check({}, { signal: controller.signal })).rejects.toThrow(ValidationError);
  });
});
