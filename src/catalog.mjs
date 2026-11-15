import { readFileSync } from "node:fs";

export const ID = "kilo-free";
export const BASE = "https://api.kilo.ai/api/gateway";
export const CHAT = "@ai-sdk/openai-compatible";
export const ANONYMOUS = "anonymous";

const EFFORTS = ["low", "medium", "high"];

const SEED = JSON.parse(
  readFileSync(new URL("./snapshot.json", import.meta.url), "utf8"),
).models;

function modalities(values) {
  return Object.fromEntries(
    ["text", "image", "audio", "video", "pdf"].map((name) => [name, values.includes(name)]),
  );
}

function shape(entry, baseURL) {
  const input = Array.isArray(entry.input) ? entry.input : ["text"];
  const parameters = Array.isArray(entry.parameters) ? entry.parameters : [];
  const toolcall = parameters.includes("tools");
  const reasoning = parameters.includes("reasoning") || parameters.includes("include_reasoning");
  return {
    id: entry.id,
    providerID: ID,
    name: entry.name || entry.id,
    api: { id: entry.id, url: baseURL, npm: CHAT },
    limit: {
      context: entry.context || 32768,
      output: entry.output || 4096,
    },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: input.some((value) => value !== "text"),
      toolcall,
      input: modalities(input),
      output: modalities(["text"]),
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // magpie turns these keys into reasoning levels. Only models that
    // advertise reasoning_effort upstream get them; inventing levels for
    // models that ignore the field would send parameters they cannot honour.
    variants: parameters.includes("reasoning_effort")
      ? Object.fromEntries(EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      : {},
    options: {},
    headers: {},
    status: "active",
    release_date: "",
    // magpie's own flag: this model does not spend any quota. `rate` cannot
    // convey it, so it has to be stated explicitly.
    free: true,
  };
}

function normalise(item) {
  const architecture = item.architecture ?? {};
  return {
    id: item.id,
    name: item.name,
    context: item.context_length ?? item.top_provider?.context_length ?? 0,
    output: item.top_provider?.max_completion_tokens ?? 0,
    input: Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities
      : ["text"],
    parameters: Array.isArray(item.supported_parameters) ? item.supported_parameters : [],
  };
}

export function buildModels(listing, baseURL = BASE) {
  const data = listing?.data;
  if (!Array.isArray(data)) throw new Error("Kilo returned an unexpected model list");
  const result = {};
  for (const item of data) {
    if (!item || typeof item.id !== "string" || !item.id || item.id === "__proto__") continue;
    // isFree is Kilo's own authoritative flag. A zero price alone is not
    // enough: a few zero-priced entries are non-chat models that answer
    // nothing on /chat/completions.
    if (item.isFree !== true) continue;
    result[item.id] = shape(normalise(item), baseURL);
  }
  if (Object.keys(result).length === 0) throw new Error("Kilo listed no free models");
  return result;
}

export function toConfigModels(models) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      {
        id: model.api?.id ?? id,
        name: model.name,
        provider: { npm: model.api.npm, api: model.api.url },
        limit: model.limit,
        reasoning: model.capabilities.reasoning,
        tool_call: model.capabilities.toolcall,
        attachment: model.capabilities.attachment,
        modalities: {
          input: Object.keys(model.capabilities.input).filter((key) => model.capabilities.input[key]),
          output: Object.keys(model.capabilities.output).filter((key) => model.capabilities.output[key]),
        },
        cost: { input: 0, output: 0 },
        variants: model.variants,
        free: true,
      },
    ]),
  );
}

export function fellBack(models) {
  const list = { ...models };
  // Tells magpie this refresh failed so it keeps the last complete list
  // instead of pruning models the user already selected.
  list[Symbol.for("magpie.fellBack")] = true;
  return list;
}

/**
 * Free-model catalog with a bounded cache.
 *
 * Kilo's free pool changes without notice, so the list is re-read rather than
 * pinned. Reads are cheap and anonymous, but they are not free of rate limits
 * (the gateway counts roughly 200 requests per hour per IP), so a stale
 * cache is preferred over a read on every request.
 */
export function createCatalog({
  baseURL = BASE,
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = 300_000,
  retryMs = 30_000,
  timeoutMs = 15_000,
  now = Date.now,
  seed = SEED,
} = {}) {
  const initial = Object.fromEntries(seed.map((entry) => [entry.id, shape(entry, baseURL)]));
  let current = initial;
  let stamp = 0;
  let triedAt = 0;
  let pending = null;

  // stamp 0 means "never read", which is not the same as "read at epoch".
  function fresh() {
    return stamp !== 0 && now() - stamp < ttlMs;
  }

  async function read(signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${baseURL}/models`, {
      headers: { accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error(`Kilo model list answered HTTP ${response.status}`);
    }
    return buildModels(await response.json(), baseURL);
  }

  function refresh(signal) {
    if (pending) return pending;
    pending = (async () => {
      try {
        current = await read(signal);
        stamp = now();
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    get current() {
      return current;
    },
    seed: initial,

    async models(signal) {
      if (fresh()) return current;
      triedAt = now();
      const outcome = await refresh(signal);
      return outcome.ok ? current : fellBack(current);
    },

    /**
     * Is this id in Kilo's current free set?
     *
     * `absent` means the catalog is current and the model is not in it — the
     * caller should answer 404 so only that model is dropped. `unknown` means
     * the catalog could not be read, so the caller should not claim the model
     * is gone.
     */
    async ensure(id) {
      if (Object.hasOwn(current, id)) return { ok: true };
      if (!fresh() && now() - triedAt >= retryMs) {
        triedAt = now();
        const outcome = await refresh();
        if (!outcome.ok) return { ok: false, reason: "unknown", error: outcome.error };
        if (Object.hasOwn(current, id)) return { ok: true };
      }
      return { ok: false, reason: "absent" };
    },
  };
}
