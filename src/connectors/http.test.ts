import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpJson } from "./http.js";
import { ConnectorError } from "../core/errors.js";
import { fakeFetch } from "../testing/fake-fetch.js";

test("get builds query strings and parses JSON", async () => {
  const fake = fakeFetch([{ match: "/things", reply: { ok: true, items: [1, 2] } }]);
  const api = new HttpJson({ connector: "t", baseUrl: "https://api.example.com", fetchImpl: fake.fetch });
  const result = await api.get<{ items: number[] }>("/things", { query: { limit: 2, q: "a b", skip: undefined } });
  assert.deepEqual(result.items, [1, 2]);
  const url = fake.requests[0]!.url;
  assert.match(url, /limit=2/);
  assert.match(url, /q=a\+b|q=a%20b/);
  assert.ok(!url.includes("skip="));
});

test("post sends a JSON body and default headers", async () => {
  const fake = fakeFetch([{ match: "/create", reply: { id: 1 } }]);
  const api = new HttpJson({
    connector: "t",
    baseUrl: "https://api.example.com",
    headers: { authorization: "Bearer xyz" },
    fetchImpl: fake.fetch,
  });
  await api.post("/create", { body: { name: "n" } });
  const req = fake.requests[0]!;
  assert.equal(req.method, "POST");
  assert.deepEqual(req.body, { name: "n" });
  assert.equal(req.headers.authorization, "Bearer xyz");
  assert.equal(req.headers["content-type"], "application/json");
});

test("4xx maps to a non-retryable ConnectorError with detail", async () => {
  const fake = fakeFetch([{ match: "/missing", reply: { message: "nope" }, status: 404 }]);
  const api = new HttpJson({ connector: "github", baseUrl: "https://api.example.com", fetchImpl: fake.fetch });
  await assert.rejects(
    () => api.get("/missing"),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.retryable, false);
      assert.match(err.message, /\[github\].*404/);
      return true;
    },
  );
  assert.equal(fake.requests.length, 1);
});

test("5xx retries then succeeds", async () => {
  const fake = fakeFetch([
    { match: "/flaky", reply: {}, status: 503, times: 1, headers: { "retry-after": "0" } },
    { match: "/flaky", reply: { fine: true } },
  ]);
  const api = new HttpJson({ connector: "t", baseUrl: "https://api.example.com", fetchImpl: fake.fetch });
  const result = await api.get<{ fine: boolean }>("/flaky");
  assert.equal(result.fine, true);
  assert.equal(fake.requests.length, 2);
});

test("retries exhaust into a retryable ConnectorError", async () => {
  const fake = fakeFetch([{ match: "/down", reply: {}, status: 500, headers: { "retry-after": "0" } }]);
  const api = new HttpJson({ connector: "t", baseUrl: "https://api.example.com", fetchImpl: fake.fetch, maxRetries: 1 });
  await assert.rejects(
    () => api.get("/down"),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(fake.requests.length, 2);
});

test("network failure maps to a retryable ConnectorError", async () => {
  const api = new HttpJson({
    connector: "t",
    baseUrl: "https://api.example.com",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    () => api.get("/x"),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.retryable, true);
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    },
  );
});
