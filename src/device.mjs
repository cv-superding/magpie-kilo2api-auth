export const AUTH_BASE = "https://api.kilo.ai/api/device-auth";

const POLL_MS = 3_000;
const TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("登录已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("登录已取消"));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Device authorisation, the flow the Kilo CLI itself uses.
 *
 * Two steps: ask for a code, then poll it until the browser approves. The
 * token never travels through a browser redirect, so this works on a server,
 * over SSH, or anywhere a localhost callback cannot be reached.
 */
export async function startDeviceAuth(fetchImpl, signal) {
  const response = await fetchImpl(`${AUTH_BASE}/codes`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel?.();
    throw new Error(`Kilo 设备授权返回 HTTP ${response.status}`);
  }
  const data = await response.json();
  if (typeof data?.code !== "string" || !data.code) {
    throw new Error("Kilo 没有返回设备码");
  }
  const verificationUrl = data.verificationUrl ?? data.verification_url;
  if (typeof verificationUrl !== "string" || !verificationUrl) {
    throw new Error("Kilo 没有返回授权地址");
  }
  return {
    code: data.code,
    userCode: typeof data.user_code === "string" ? data.user_code : data.code,
    verificationUrl,
    expiresIn: Number.isFinite(data.expiresIn) ? data.expiresIn : undefined,
  };
}

function approval(data) {
  const access = data?.access ?? data?.access_token ?? data?.token;
  if (typeof access !== "string" || !access) {
    throw new Error("Kilo 批准了设备但未返回 token");
  }
  const refresh = data.refresh ?? data.refresh_token;
  // expires_in is an OAuth token lifetime in seconds. The device code's own
  // expiresIn is unrelated and must not be read as one.
  const expiresIn = Number(data.expires_in);
  const expires = Number.isFinite(data.expires)
    ? data.expires
    : Number.isFinite(expiresIn)
      ? Date.now() + expiresIn * 1000
      : undefined;
  const email = data.userEmail ?? data.email ?? data.user?.email;
  return {
    access,
    ...(typeof refresh === "string" && refresh ? { refresh } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(typeof email === "string" && email ? { accountId: email } : {}),
  };
}

export async function pollDeviceAuth(fetchImpl, code, signal, { pollMs = POLL_MS, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error("登录已取消");
    const response = await fetchImpl(`${AUTH_BASE}/codes/${encodeURIComponent(code)}`, {
      headers: { accept: "application/json" },
      signal,
      redirect: "error",
    });

    if (response.status === 200) {
      return approval(await response.json());
    }
    if (response.status === 202) {
      await response.body?.cancel?.();
      if (now() >= deadline) throw new Error("设备授权超时，请重新登录");
      await sleep(pollMs, signal);
      continue;
    }
    if (response.status === 403) {
      await response.body?.cancel?.();
      throw new Error("Kilo 拒绝了这次设备授权");
    }
    if (response.status === 410) {
      await response.body?.cancel?.();
      throw new Error("设备码已过期，请重新登录");
    }
    await response.body?.cancel?.();
    throw new Error(`Kilo 设备授权返回 HTTP ${response.status}`);
  }
}
