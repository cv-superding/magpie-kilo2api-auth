import {
  ANONYMOUS,
  BASE,
  CHAT,
  ID,
  createCatalog,
  toConfigModels,
} from "./catalog.mjs";
import { pollDeviceAuth, startDeviceAuth } from "./device.mjs";
import { readLocalSignIn } from "./local.mjs";

const PAID_ONLY = /paid_model_auth_required|PAID_MODEL_AUTH_REQUIRED/;
const PROFILE = "https://api.kilo.ai/api/profile";

/**
 * The account behind a token, used only to label it in magpie. Callers treat
 * any failure as "no label" and fall back to the id inside the token.
 */
async function profileOf(fetchImpl, token, signal) {
  try {
    const response = await fetchImpl(PROFILE, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      return null;
    }
    const user = (await response.json())?.user;
    if (!user || typeof user !== "object") return null;
    const id = typeof user.id === "string" ? user.id : undefined;
    const email = typeof user.email === "string" ? user.email : undefined;
    if (!id && !email) return null;
    return { id, email };
  } catch {
    return null;
  }
}

function plainURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected a plain HTTP(S) base URL without credentials or query");
  }
  return url.href.replace(/\/+$/, "");
}

export function modeOf(auth) {
  if (auth?.type === "oauth" && typeof auth.access === "string" && auth.access) {
    return auth.metadata?.mode === "local" ? "local" : "oauth";
  }
  if (auth?.type === "api" && typeof auth.key === "string" && auth.key) {
    const mode = auth.metadata?.mode;
    if (mode === "anonymous" || auth.key === ANONYMOUS) return "anonymous";
    if (mode === "local") return "local";
    return "key";
  }
  throw new Error("Kilo Free needs a Kilo sign-in, an imported account or an API key");
}

/** The bearer token a sign-in resolves to, or null when none is stored. */
export function tokenOf(auth) {
  if (auth?.type === "oauth") return typeof auth.access === "string" ? auth.access : null;
  if (typeof auth?.key === "string" && auth.key && auth.key !== ANONYMOUS) return auth.key;
  return null;
}

function failure(status, type, message, extra = {}) {
  return new Response(JSON.stringify({ error: { message, type, ...extra } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

async function readBody(input, init) {
  const raw = init?.body;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
  if (raw && typeof raw.text === "function") return await raw.text();
  if (raw) return await new Response(raw).text();
  if (typeof Request !== "undefined" && input instanceof Request) return await input.clone().text();
  return "";
}

/**
 * Kilo answers 401 PAID_MODEL_AUTH_REQUIRED for a paid model on an anonymous
 * session. magpie reads a 401 that mentions signing in as "this account needs
 * to sign in again" and would disable the account, so the meaning is restated
 * as a model-level rejection. Every other status passes through untouched.
 */
async function restate(response) {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  if (response.status === 401 && PAID_ONLY.test(text)) {
    return new Response(text, {
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-magpie-sign-in": "kept",
      },
    });
  }
  return new Response(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

export async function KiloFreePlugin(_input = {}, options = {}) {
  const baseURL = plainURL(options.baseURL ?? BASE);
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const catalog = createCatalog({ ...options, baseURL, fetchImpl });
  const chatURL = `${baseURL}/chat/completions`;
  const readLocal = options.readLocal ?? (() => readLocalSignIn());

  async function handle(input, init, getAuth) {
    if ((init?.method ?? input?.method ?? "POST").toUpperCase() !== "POST") {
      return failure(404, "invalid_request_error", `Kilo Free only proxies ${chatURL}`);
    }
    if (urlOf(input) !== chatURL) {
      return failure(404, "invalid_request_error", `Kilo Free only proxies ${chatURL}`);
    }

    const raw = await readBody(input, init);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return failure(400, "invalid_request_error", "Expected a JSON request body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string") {
      return failure(400, "invalid_request_error", "Expected a chat request carrying a model id");
    }

    const auth = await getAuth();
    if (!auth) {
      return failure(401, "authentication_error", "Kilo Free is not signed in");
    }
    const mode = modeOf(auth);

    const verdict = await catalog.ensure(body.model);
    if (!verdict.ok) {
      return verdict.reason === "absent"
        ? failure(
            404,
            "model_not_found",
            `Model ${body.model} is not a free model on Kilo Gateway right now. Free models: ${Object.keys(catalog.current).join(", ")}.`,
          )
        : failure(
            503,
            "catalog_unavailable",
            `Could not confirm Kilo's free model list: ${verdict.error?.message ?? "unknown error"}`,
          );
    }

    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set(
      "accept",
      body.stream === true ? "text/event-stream" : "application/json",
    );
    // Anonymous calls carry no Authorization header at all. Kilo validates any
    // header it is given, and placeholder tokens are rejected, so the header
    // is omitted rather than filled with a dummy value.
    if (mode === "local") {
      // Re-read on every request so the plugin follows the desktop app: a
      // fresh sign-in, a switched account or a sign-out all take effect
      // without importing again.
      const local = readLocal();
      if (!local) {
        return failure(
          401,
          "authentication_error",
          "Kilo is no longer signed in on this machine. Import the account again, or switch to anonymous access.",
        );
      }
      headers.set("authorization", `Bearer ${local.key}`);
    } else if (mode !== "anonymous") {
      const token = tokenOf(auth);
      if (!token) {
        return failure(401, "authentication_error", "The Kilo sign-in carries no access token.");
      }
      headers.set("authorization", `Bearer ${token}`);
    }

    const upstream = await fetchImpl(chatURL, {
      method: "POST",
      headers,
      body: raw,
      signal: init?.signal,
      redirect: "error",
    });
    return restate(upstream);
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {
        name: "Kilo Gateway Free",
        npm: CHAT,
        api: baseURL,
        models: toConfigModels(catalog.seed),
      };
    },

    auth: {
      provider: ID,
      icon: "https://kilo.ai/favicon.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          keyless: true,
          label: "匿名免费访问（无需账号，确认即可）",
          placeholder: ANONYMOUS,
          async authorize() {
            return { type: "success", key: ANONYMOUS, metadata: { mode: "anonymous" } };
          },
        },
        {
          type: "oauth",
          label: "浏览器登录 Kilo 账号（设备码，可重复添加多个账号）",
          async authorize() {
            const start = await startDeviceAuth(fetchImpl);
            return {
              url: start.verificationUrl,
              instructions: `在浏览器中打开上面的地址，确认设备码 ${start.userCode}`,
              method: "auto",
              async callback(_code, { signal } = {}) {
                const approved = await pollDeviceAuth(fetchImpl, start.code, signal);
                const account = approved.accountId
                  ? null
                  : await profileOf(fetchImpl, approved.access, signal);
                return {
                  type: "success",
                  ...approved,
                  ...(account?.email ? { accountId: account.email } : {}),
                  ...(account?.id ? { uid: account.id } : {}),
                };
              },
            };
          },
        },
        {
          type: "api",
          keyless: true,
          label: "从 Kilo 桌面端 / CLI 导入（读本机登录）",
          async authorize() {
            const local = readLocal();
            if (!local) {
              return {
                type: "failed",
                error:
                  "没找到 Kilo 的登录信息。请先在 Kilo 桌面端或 CLI 登录，或改用匿名访问 / API Key。",
              };
            }
            // Stored as an oauth sign-in rather than an api key: magpie only
            // tells accounts apart — and so only allows several of them —
            // when the credential carries an access token and an accountId.
            const account = await profileOf(fetchImpl, local.key);
            return {
              type: "success",
              access: local.key,
              ...(local.refresh ? { refresh: local.refresh } : {}),
              ...(local.expires ? { expires: local.expires } : {}),
              accountId: account?.email ?? local.accountId,
              ...(account?.id ? { uid: account.id } : {}),
              metadata: { mode: "local" },
            };
          },
        },
        {
          type: "api",
          label: "Kilo API Key（可选，提升限额）",
          placeholder: "kilo-…",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const mode = modeOf(auth);
        return {
          baseURL,
          // Empty apiKey keeps the OpenAI SDK from inventing a bearer header
          // for the anonymous session. A local import re-reads the real token
          // inside fetch, so this snapshot only has to be non-empty.
          apiKey: mode === "anonymous" ? "" : (tokenOf(auth) ?? ""),
          async fetch(input, init) {
            return handle(input, init, getAuth);
          },
        };
      },
      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const mode = modeOf(auth);
        const plan =
          mode === "key"
            ? "Kilo Gateway (API key)"
            : mode === "local"
              ? "Kilo account (imported)"
              : mode === "oauth"
                ? "Kilo account"
                : "Kilo Gateway Free";
        return { plan, windows: [] };
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        modeOf(auth);
        return catalog.models();
      },
    },
  };
}
