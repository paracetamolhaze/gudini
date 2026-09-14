import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreadsClient } from "../../src/threads/client.js";
import { AuthenticationError, PermissionError, RateLimitError, errorFor, ServerError, ContainerError } from "../../src/threads/errors.js";

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const { status, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("errorFor maps Meta codes to typed errors with the missing scope named", () => {
  const perm = errorFor(400, "/keyword_search", JSON.stringify({ error: { message: "(#10) Permission denied", code: 10 } }));
  assert.ok(perm instanceof PermissionError);
  assert.equal(perm.scope, "threads_keyword_search");
  const rate = errorFor(400, "/me/threads", JSON.stringify({ error: { message: "too many", code: 4 } }));
  assert.ok(rate instanceof RateLimitError);
  const auth = errorFor(400, "/me", JSON.stringify({ error: { message: "expired", code: 190, error_subcode: 463 } }));
  assert.ok(auth instanceof AuthenticationError);
  const server = errorFor(502, "/me", "<html>bad gateway</html>");
  assert.ok(server instanceof ServerError);
});

test("client retries 5xx and returns parsed JSON; access token never appears in thrown messages", async () => {
  let calls = 0;
  const client = new ThreadsClient({
    accessToken: "SECRET_TOKEN_123",
    userId: "42",
    minRequestIntervalMs: 0,
    maxRetries: 2,
    fetchImpl: fakeFetch((url) => {
      calls++;
      assert.equal(url.searchParams.get("access_token"), "SECRET_TOKEN_123");
      if (calls === 1) return { status: 503, body: { error: { message: "try later", code: 2 } } };
      return { status: 200, body: { data: [{ id: "1", text: "hello" }] } };
    }),
  });
  const res = await client.myPosts({ limit: 5 });
  assert.equal(calls, 2);
  assert.equal(res.data[0]?.text, "hello");
});

test("client does not retry 400 validation errors", async () => {
  let calls = 0;
  const client = new ThreadsClient({
    accessToken: "t",
    userId: "42",
    minRequestIntervalMs: 0,
    fetchImpl: fakeFetch(() => {
      calls++;
      return { status: 400, body: { error: { message: "Invalid parameter", code: 100 } } };
    }),
  });
  await assert.rejects(() => client.myPosts(), (err: Error) => /Invalid parameter/.test(err.message));
  assert.equal(calls, 1);
});

test("expired token (190/463) triggers one refresh and a retry with the new token", async () => {
  const seen: string[] = [];
  let refreshed: string | undefined;
  const client = new ThreadsClient({
    accessToken: "old",
    userId: "42",
    minRequestIntervalMs: 0,
    onTokenRefreshed: (t) => {
      refreshed = t;
    },
    fetchImpl: fakeFetch((url) => {
      if (url.pathname.endsWith("/refresh_access_token")) return { status: 200, body: { access_token: "new", expires_in: 5_000_000 } };
      const tok = url.searchParams.get("access_token") ?? "";
      seen.push(tok);
      if (tok === "old") return { status: 400, body: { error: { message: "Session expired", code: 190, error_subcode: 463 } } };
      return { status: 200, body: { data: [] } };
    }),
  });
  await client.myPosts();
  assert.deepEqual(seen, ["old", "new"]);
  assert.equal(refreshed, "new");
});

test("awaitContainer polls status until FINISHED and surfaces ERROR with the reason", async () => {
  const statuses = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
  const client = new ThreadsClient({
    accessToken: "t",
    userId: "42",
    minRequestIntervalMs: 0,
    containerTimeoutMs: 10_000,
    fetchImpl: fakeFetch((url) => {
      if (url.pathname.endsWith("/c1")) return { status: 200, body: { status: statuses.shift() ?? "FINISHED" } };
      if (url.pathname.endsWith("/c2")) return { status: 200, body: { status: "ERROR", error_message: "Media download failed" } };
      return { status: 404, body: {} };
    }),
  });
  await client.awaitContainer("c1");
  await assert.rejects(() => client.awaitContainer("c2"), (err: Error) => err instanceof ContainerError && /Media download failed/.test(err.message));
});

test("keywordSearch passes author_username so a profile can be watched without profile_posts", async () => {
  let params: URLSearchParams | null = null;
  const client = new ThreadsClient({
    accessToken: "t",
    userId: "42",
    minRequestIntervalMs: 0,
    fetchImpl: fakeFetch((url) => {
      params = url.searchParams;
      return { status: 200, body: { data: [] } };
    }),
  });
  await client.keywordSearch({ q: "bitcoin", authorUsername: "@some_blogger", since: 1700000000 });
  assert.equal(params!.get("author_username"), "some_blogger");
  assert.equal(params!.get("search_type"), "RECENT");
  assert.equal(params!.get("since"), "1700000000");
});
