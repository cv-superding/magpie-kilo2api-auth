import assert from "node:assert/strict";
import test from "node:test";

import { authFiles, readLocalSignIn } from "../src/local.mjs";

const HOME = String.raw`C:\Users\test`;

function reader(files) {
  return (file) => {
    if (Object.hasOwn(files, file)) return files[file];
    const error = new Error(`ENOENT: ${file}`);
    error.code = "ENOENT";
    throw error;
  };
}

test("an oauth store is read as an access token", () => {
  const file = String.raw`C:\Users\test\.local\share\kilo\auth.json`;
  const found = readLocalSignIn({
    env: {},
    home: HOME,
    read: reader({
      [file]: JSON.stringify({
        kilo: { type: "oauth", access: "acc-token", refresh: "ref-token", expires: 1826095342340 },
      }),
    }),
  });
  assert.equal(found.key, "acc-token");
  assert.equal(found.kind, "oauth");
  assert.equal(found.refresh, "ref-token");
  assert.equal(found.expires, 1826095342340);
  assert.equal(found.file, file);
});

test("an api key store is read as a key", () => {
  const file = String.raw`C:\Users\test\.config\kilo\auth.json`;
  const found = readLocalSignIn({
    env: {},
    home: HOME,
    read: reader({ [file]: JSON.stringify({ kilo: { type: "api", key: "kilo-key" } }) }),
  });
  assert.equal(found.key, "kilo-key");
  assert.equal(found.kind, "key");
});

test("the account id is taken from the token when the store has none", () => {
  const payload = Buffer.from(
    JSON.stringify({ kiloUserId: "068368d3-f19d-46cd-9234-f58f0f63c409" }),
    "utf8",
  ).toString("base64url");
  const token = `header.${payload}.signature`;
  const file = String.raw`C:\Users\test\.local\share\kilo\auth.json`;
  const found = readLocalSignIn({
    env: {},
    home: HOME,
    read: reader({ [file]: JSON.stringify({ kilo: { type: "oauth", access: token } }) }),
  });
  // Without a readable id magpie cannot tell two imports apart.
  assert.equal(found.accountId, "068368d3-f19d-46cd-9234-f58f0f63c409");
});

test("an explicit accountId in the store wins over the token", () => {
  const file = String.raw`C:\Users\test\.local\share\kilo\auth.json`;
  const found = readLocalSignIn({
    env: {},
    home: HOME,
    read: reader({
      [file]: JSON.stringify({ kilo: { type: "oauth", access: "a.b.c", accountId: "named" } }),
    }),
  });
  assert.equal(found.accountId, "named");
});

test("the first readable candidate wins", () => {
  const data = String.raw`C:\xdg\data\kilo\auth.json`;
  const found = readLocalSignIn({
    env: { XDG_DATA_HOME: String.raw`C:\xdg\data` },
    home: HOME,
    read: reader({ [data]: JSON.stringify({ kilo: { type: "oauth", access: "from-xdg" } }) }),
  });
  assert.equal(found.key, "from-xdg");
});

test("KILO_AUTH_CONTENT overrides the files on disk", () => {
  const found = readLocalSignIn({
    env: { KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: "oauth", access: "inline" } }) },
    home: HOME,
    read: () => {
      throw new Error("must not touch the disk");
    },
  });
  assert.equal(found.key, "inline");
  assert.equal(found.file, "KILO_AUTH_CONTENT");
});

test("a machine with no Kilo sign-in yields null", () => {
  assert.equal(readLocalSignIn({ env: {}, home: HOME, read: reader({}) }), null);
});

test("malformed or unrelated stores are ignored", () => {
  const file = String.raw`C:\Users\test\.local\share\kilo\auth.json`;
  const read = reader({ [file]: JSON.stringify({ anthropic: { type: "api", key: "other" } }) });
  assert.equal(readLocalSignIn({ env: {}, home: HOME, read }), null);

  const broken = reader({ [file]: "{not json" });
  assert.equal(readLocalSignIn({ env: {}, home: HOME, read: broken }), null);

  const headless = reader({ [file]: JSON.stringify({ kilo: { type: "oauth", access: "" } }) });
  assert.equal(readLocalSignIn({ env: {}, home: HOME, read: headless }), null);
});

test("candidate paths cover xdg, dotfiles and windows app data", () => {
  const env = {
    XDG_DATA_HOME: String.raw`C:\xdg\data`,
    XDG_CONFIG_HOME: String.raw`C:\xdg\config`,
    LOCALAPPDATA: String.raw`C:\Local`,
    APPDATA: String.raw`C:\Roaming`,
  };
  const files = authFiles(env, HOME);
  assert.equal(files[0], String.raw`C:\xdg\data\kilo\auth.json`);
  assert.ok(files.includes(String.raw`C:\Users\test\.local\share\kilo\auth.json`));
  assert.ok(files.includes(String.raw`C:\xdg\config\kilo\auth.json`));
  assert.ok(files.includes(String.raw`C:\Users\test\.config\kilo\auth.json`));
  assert.ok(files.includes(String.raw`C:\Local\kilo\auth.json`));
  assert.ok(files.includes(String.raw`C:\Roaming\kilo\auth.json`));
  assert.equal(new Set(files).size, files.length);
});
