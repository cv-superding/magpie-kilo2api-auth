import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Kilo Desktop, the VS Code extension and the CLI all read and write one
 * shared auth store, in the OpenCode layout:
 *
 *   { "kilo": { "type": "oauth", "access": "…", "refresh": "…", "expires": 0 } }
 *
 * Signing in there is enough to use the same account here, so this module
 * only ever reads it.
 */
export function authFiles(env = process.env, home = homedir()) {
  const files = [];
  if (env.XDG_DATA_HOME) files.push(join(env.XDG_DATA_HOME, "kilo", "auth.json"));
  files.push(join(home, ".local", "share", "kilo", "auth.json"));
  if (env.XDG_CONFIG_HOME) files.push(join(env.XDG_CONFIG_HOME, "kilo", "auth.json"));
  files.push(join(home, ".config", "kilo", "auth.json"));
  if (env.LOCALAPPDATA) files.push(join(env.LOCALAPPDATA, "kilo", "auth.json"));
  if (env.APPDATA) files.push(join(env.APPDATA, "kilo", "auth.json"));
  return [...new Set(files)];
}

/** Reads the payload of a JWT without verifying it; only used for labels. */
function claims(token) {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function parse(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = data?.kilo ?? data?.["kilo-gateway"];
  if (!entry || typeof entry !== "object") return null;

  if (entry.type === "api" && typeof entry.key === "string" && entry.key) {
    return { key: entry.key, kind: "key" };
  }
  if (typeof entry.access !== "string" || !entry.access) return null;

  // Kilo does not store a name for the account, so the stable user id inside
  // the token is used instead: magpie shows it as the account label and uses
  // it to tell several signed-in accounts apart.
  const id = entry.accountId ?? claims(entry.access).kiloUserId;

  return {
    key: entry.access,
    kind: "oauth",
    refresh: typeof entry.refresh === "string" && entry.refresh ? entry.refresh : undefined,
    expires: Number.isFinite(entry.expires) ? entry.expires : undefined,
    accountId: typeof id === "string" && id ? id : undefined,
  };
}

/**
 * The most recent Kilo sign-in found on this machine, or null.
 *
 * `KILO_AUTH_CONTENT` wins when set, because that is how Kilo itself lets a
 * caller override the store, and it keeps tests off the real home directory.
 */
export function readLocalSignIn({
  env = process.env,
  home = homedir(),
  read = readFileSync,
} = {}) {
  if (env.KILO_AUTH_CONTENT) {
    const inline = parse(env.KILO_AUTH_CONTENT);
    if (inline) return { ...inline, file: "KILO_AUTH_CONTENT" };
  }
  for (const file of authFiles(env, home)) {
    try {
      const found = parse(read(file, "utf8"));
      if (found) return { ...found, file };
    } catch {
      // Not every candidate exists; keep looking.
    }
  }
  return null;
}
