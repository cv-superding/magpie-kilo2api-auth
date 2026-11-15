import assert from "node:assert/strict";
import test from "node:test";

import { BASE } from "../src/catalog.mjs";
import { KiloFreePlugin } from "../src/provider.mjs";

const listing = {
  data: [
    {
      id: "nvidia/nemotron-3.5-lightning:free",
      name: "Nemotron 3.5 Lightning",
      isFree: true,
      context_length: 1000000,
      top_provider: { max_completion_tokens: 32768 },
      supported_parameters: ["tools", "reasoning"],
    },
  ],
};

const ANONYMOUS_AUTH = { type: "api", key: "anonymous", metadata: { mode: "anonymous" } };

function harness({ paid = false, models = () => new Response(JSON.stringify(listing), { status: 200 }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()), body: init.body });
    if (url.endsWith("/models")) return models();
    if (paid) {
      return new Response(
        JSON.stringify({
          error: { code: "PAID_MODEL_AUTH_REQUIRED", message: "You need to sign in to use this model." },
          error_type: "paid_model_auth_required",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return new Response('data: {"choices":[]}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { calls, fetchImpl };
}

async function signed(env, auth = ANONYMOUS_AUTH, options = {}) {
  const hooks = await KiloFreePlugin({}, { fetchImpl: env.fetchImpl, ttlMs: 0, ...options });
  const config = {};
  await hooks.config(config);
  const provider = config.provider["kilo-free"];
  const loader = await hooks.auth.loader(async () => auth);
  const send = (body, path = `${BASE}/chat/completions`) =>
    loader.fetch(path, { method: "POST", body: JSON.stringify(body) });
  return { hooks, provider, loader, send };
}

test("config declares an OpenAI-compatible provider seeded from the snapshot", async () => {
  const env = harness();
  const { provider } = await signed(env);
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider.api, BASE);
  assert.equal(Object.keys(provider.models).length, 14);
});

test("anonymous sign-in carries no api key", async () => {
  const env = harness();
  const { loader } = await signed(env);
  assert.equal(loader.apiKey, "");
  assert.equal(loader.baseURL, BASE);
});

test("anonymous requests are forwarded without an Authorization header", async () => {
  const env = harness();
  const { send } = await signed(env);
  const body = { model: "nvidia/nemotron-3.5-lightning:free", messages: [], stream: true };
  const response = await send(body);
  assert.equal(response.status, 200);
  const call = env.calls.at(-1);
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.headers.accept, "text/event-stream");
  assert.equal(call.body, JSON.stringify(body));
});

test("an oauth sign-in sends its access token", async () => {
  const env = harness();
  const { send } = await signed(env, { type: "oauth", access: "oauth-access", refresh: "r" });
  const response = await send({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] });
  assert.equal(response.status, 200);
  assert.equal(env.calls.at(-1).headers.authorization, "Bearer oauth-access");
});

test("an API key is forwarded as a bearer token", async () => {
  const env = harness();
  const { send } = await signed(env, { type: "api", key: "kilo-live" });
  await send({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] });
  assert.equal(env.calls.at(-1).headers.authorization, "Bearer kilo-live");
});

test("a model outside the free catalog answers 404 instead of 401", async () => {
  const env = harness();
  const { send } = await signed(env);
  const response = await send({ model: "anthropic/claude-haiku-5.5", messages: [] });
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error.type, "model_not_found");
});

test("a 401 about a paid model is restated as a model-level rejection", async () => {
  const env = harness({ paid: true });
  const { send } = await signed(env);
  const response = await send({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] });
  // 401 would make magpie disable the account; this is a per-model refusal.
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
  assert.equal((await response.json()).error.code, "PAID_MODEL_AUTH_REQUIRED");
});

test("requests outside the chat endpoint are refused", async () => {
  const env = harness();
  const { send } = await signed(env);
  const response = await send({}, `${BASE}/embeddings`);
  assert.equal(response.status, 404);
  assert.equal(env.calls.filter((call) => !call.url.endsWith("/models")).length, 0);
});

test("a body without a model id is refused before reaching upstream", async () => {
  const env = harness();
  const { send } = await signed(env);
  const response = await send({ messages: [] });
  assert.equal(response.status, 400);
  assert.equal(env.calls.filter((call) => !call.url.endsWith("/models")).length, 0);
});

test("the models hook follows the live free set", async () => {
  const env = harness();
  const { hooks, provider } = await signed(env);
  const models = await hooks.provider.models(provider, { auth: ANONYMOUS_AUTH });
  assert.deepEqual(Object.keys(models), ["nvidia/nemotron-3.5-lightning:free"]);
  assert.equal(models["nvidia/nemotron-3.5-lightning:free"].free, true);
});

test("the models hook keeps the declared list while signed out", async () => {
  const env = harness();
  const { hooks, provider } = await signed(env);
  const models = await hooks.provider.models(provider, {});
  assert.equal(Object.keys(models).length, 14);
});

test("a local import sends the token read from this machine", async () => {
  const env = harness();
  const hooks = await KiloFreePlugin(
    {},
    { fetchImpl: env.fetchImpl, ttlMs: 0, readLocal: () => ({ key: "fresh-from-desktop" }) },
  );
  const loader = await hooks.auth.loader(async () => ({
    type: "api",
    key: "snapshot-taken-at-import",
    metadata: { mode: "local" },
  }));

  const response = await loader.fetch(`${BASE}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] }),
  });
  assert.equal(response.status, 200);
  // The store is re-read per request, so a token refreshed in the desktop app
  // takes effect without importing again.
  assert.equal(env.calls.at(-1).headers.authorization, "Bearer fresh-from-desktop");
});

test("a local import fails loudly once the desktop session is gone", async () => {
  const env = harness();
  const hooks = await KiloFreePlugin(
    {},
    { fetchImpl: env.fetchImpl, ttlMs: 0, readLocal: () => null },
  );
  const loader = await hooks.auth.loader(async () => ({
    type: "api",
    key: "snapshot-taken-at-import",
    metadata: { mode: "local" },
  }));

  const response = await loader.fetch(`${BASE}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] }),
  });
  assert.equal(response.status, 401);
  assert.equal(env.calls.filter((call) => !call.url.endsWith("/models")).length, 0);
});

test("importing builds a local sign-in from the store", async () => {
  const hooks = await KiloFreePlugin(
    {},
    {
      fetchImpl: harness().fetchImpl,
      readLocal: () => ({
        key: "acc-token",
        kind: "oauth",
        refresh: "ref-token",
        expires: 1826095342340,
      }),
    },
  );
  // The anonymous method is keyless too, so the import is found by its label.
  const method = hooks.auth.methods.find((entry) => /导入/.test(entry.label ?? ""));
  assert.ok(method, "expected an import method");
  const result = await method.authorize();
  assert.equal(result.type, "success");
  // oauth shape, so magpie treats each import as its own account
  assert.equal(result.access, "acc-token");
  assert.equal(result.refresh, "ref-token");
  assert.equal(result.expires, 1826095342340);
  assert.equal(result.metadata.mode, "local");
});

test("importing without a Kilo sign-in reports a readable failure", async () => {
  const hooks = await KiloFreePlugin(
    {},
    { fetchImpl: harness().fetchImpl, readLocal: () => null },
  );
  const method = hooks.auth.methods.find((entry) => /导入/.test(entry.label ?? ""));
  const result = await method.authorize();
  assert.equal(result.type, "failed");
  assert.match(result.error, /登录/);
});

test("an unreadable catalog keeps the last known list", async () => {
  const env = harness({
    models: () => {
      throw new Error("offline");
    },
  });
  const { hooks, provider } = await signed(env);
  const models = await hooks.provider.models(provider, { auth: ANONYMOUS_AUTH });
  assert.equal(Object.keys(models).length, 14);
  assert.equal(models[Symbol.for("magpie.fellBack")], true);
});
