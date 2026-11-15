import assert from "node:assert/strict";
import test from "node:test";

import { BASE, buildModels, createCatalog, fellBack, toConfigModels } from "../src/catalog.mjs";

const listing = {
  data: [
    {
      id: "nvidia/nemotron-3.5-lightning:free",
      name: "Nemotron 3.5 Lightning",
      isFree: true,
      context_length: 1000000,
      top_provider: { context_length: 1000000, max_completion_tokens: 32768 },
      architecture: { input_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning", "reasoning_effort"],
    },
    {
      id: "google/lyria-3-pro-preview",
      name: "Lyria",
      isFree: false,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: [],
    },
    { id: "__proto__", isFree: true },
    { id: "", isFree: true },
    null,
  ],
};

test("isFree is the only admission rule", () => {
  const models = buildModels(listing, BASE);
  assert.deepEqual(Object.keys(models), ["nvidia/nemotron-3.5-lightning:free"]);
});

test("a zero price without isFree is not enough", () => {
  // Zero-priced non-chat models exist upstream and would answer nothing on
  // /chat/completions, so price alone cannot decide membership.
  assert.equal(buildModels(listing, BASE)["google/lyria-3-pro-preview"], undefined);
});

test("model shape matches what magpie reads", () => {
  const model = buildModels(listing, BASE)["nvidia/nemotron-3.5-lightning:free"];
  assert.equal(model.free, true);
  assert.equal(model.api.url, BASE);
  assert.equal(model.api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(model.limit, { context: 1000000, output: 32768 });
  assert.equal(model.capabilities.toolcall, true);
  assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.attachment, false);
  assert.deepEqual(Object.keys(model.variants), ["low", "medium", "high"]);
});

test("models without reasoning_effort get no invented levels", () => {
  const models = buildModels(
    { data: [{ id: "plain/free", isFree: true, supported_parameters: ["reasoning", "tools"] }] },
    BASE,
  );
  assert.deepEqual(models["plain/free"].variants, {});
  assert.equal(models["plain/free"].capabilities.reasoning, true);
});

test("an empty free set is an error, not a new list", () => {
  assert.throws(() => buildModels({ data: [] }, BASE), /no free models/);
  assert.throws(() => buildModels({}, BASE), /unexpected model list/);
});

test("config shape carries the free flag", () => {
  const config = toConfigModels(buildModels(listing, BASE));
  assert.equal(config["nvidia/nemotron-3.5-lightning:free"].free, true);
  assert.equal(config["nvidia/nemotron-3.5-lightning:free"].tool_call, true);
});

test("fellBack marks a degraded refresh without mutating the source", () => {
  const models = { "a/b": { id: "a/b" } };
  const flagged = fellBack(models);
  assert.equal(flagged[Symbol.for("magpie.fellBack")], true);
  assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
  assert.equal(flagged["a/b"], models["a/b"]);
});

test("catalog falls back to the snapshot when the list cannot be read", async () => {
  const catalog = createCatalog({
    baseURL: BASE,
    fetchImpl: async () => new Response("boom", { status: 500 }),
    ttlMs: 0,
    now: () => 1_000_000,
  });
  const models = await catalog.models();
  assert.equal(Object.keys(models).length, 14);
  assert.equal(models[Symbol.for("magpie.fellBack")], true);
});

test("catalog reports absent models and unreadable catalogs apart", async () => {
  const readable = createCatalog({
    baseURL: BASE,
    fetchImpl: async () => new Response(JSON.stringify(listing), { status: 200 }),
    ttlMs: 0,
    now: () => 1_000_000,
  });
  assert.deepEqual(await readable.ensure("nope/missing"), { ok: false, reason: "absent" });
  assert.deepEqual(await readable.ensure("nvidia/nemotron-3.5-lightning:free"), { ok: true });

  const unreadable = createCatalog({
    baseURL: BASE,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    ttlMs: 0,
    now: () => 1_000_000,
  });
  const verdict = await unreadable.ensure("nope/missing");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unknown");
});

test("catalog does not re-read within the ttl", async () => {
  let reads = 0;
  const catalog = createCatalog({
    baseURL: BASE,
    fetchImpl: async () => {
      reads += 1;
      return new Response(JSON.stringify(listing), { status: 200 });
    },
    ttlMs: 60_000,
    now: () => 5_000,
  });
  await catalog.models();
  await catalog.models();
  await catalog.ensure("nope/missing");
  assert.equal(reads, 1);
});
