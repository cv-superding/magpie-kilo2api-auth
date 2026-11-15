import assert from "node:assert/strict";
import test from "node:test";

import { AUTH_BASE, pollDeviceAuth, startDeviceAuth } from "../src/device.mjs";

const START = {
  code: "poll-code",
  user_code: "AKP2-8JME",
  device_code: "device-code",
  verificationUrl: "https://app.kilo.ai/device-auth?code=AKP2-8JME",
  expiresIn: 599,
};

test("starting a device authorisation returns a code and a browser address", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method });
    return new Response(JSON.stringify(START), { status: 200 });
  };
  const start = await startDeviceAuth(fetchImpl);
  assert.equal(start.code, "poll-code");
  assert.equal(start.userCode, "AKP2-8JME");
  assert.equal(start.verificationUrl, "https://app.kilo.ai/device-auth?code=AKP2-8JME");
  assert.equal(calls[0].url, `${AUTH_BASE}/codes`);
  assert.equal(calls[0].method, "POST");
});

test("a device response without a code or url is rejected", async () => {
  await assert.rejects(
    startDeviceAuth(async () => new Response(JSON.stringify({ code: "" }), { status: 200 })),
    /设备码/,
  );
  await assert.rejects(
    startDeviceAuth(
      async () => new Response(JSON.stringify({ code: "x", user_code: "y" }), { status: 200 }),
    ),
    /授权地址/,
  );
  await assert.rejects(
    startDeviceAuth(async () => new Response("nope", { status: 500 })),
    /HTTP 500/,
  );
});

test("polling waits through pending and returns the token once approved", async () => {
  let seen = 0;
  const fetchImpl = async () => {
    seen += 1;
    if (seen <= 2) return new Response(JSON.stringify({ status: "pending" }), { status: 202 });
    return new Response(
      JSON.stringify({ status: "approved", token: "acc", userEmail: "user@example.com" }),
      { status: 200 },
    );
  };
  const approved = await pollDeviceAuth(fetchImpl, "poll-code", undefined, { pollMs: 1 });
  assert.equal(approved.access, "acc");
  assert.equal(approved.accountId, "user@example.com");
  assert.equal(seen, 3);
});

test("an approval in oauth shape is understood too", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        access_token: "acc-2",
        refresh_token: "ref-2",
        expires_in: 3600,
        email: "someone@example.com",
      }),
      { status: 200 },
    );
  const approved = await pollDeviceAuth(fetchImpl, "poll-code", undefined, { pollMs: 1 });
  assert.equal(approved.access, "acc-2");
  assert.equal(approved.refresh, "ref-2");
  assert.equal(approved.accountId, "someone@example.com");
  assert.ok(approved.expires > Date.now());
});

test("the device code's own expiry is not read as a token lifetime", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ token: "acc", expiresIn: 599 }), { status: 200 });
  const approved = await pollDeviceAuth(fetchImpl, "poll-code", undefined, { pollMs: 1 });
  assert.equal(approved.expires, undefined);
});

test("a refusal or an expired code stops polling", async () => {
  await assert.rejects(
    pollDeviceAuth(async () => new Response("", { status: 403 }), "c", undefined, { pollMs: 1 }),
    /拒绝/,
  );
  await assert.rejects(
    pollDeviceAuth(async () => new Response("", { status: 410 }), "c", undefined, { pollMs: 1 }),
    /过期/,
  );
});

test("polling gives up instead of waiting forever", async () => {
  let clock = 0;
  const fetchImpl = async () => new Response(JSON.stringify({ status: "pending" }), { status: 202 });
  await assert.rejects(
    pollDeviceAuth(fetchImpl, "c", undefined, {
      pollMs: 1,
      timeoutMs: 3_000,
      now: () => (clock += 1_000),
    }),
    /超时/,
  );
});

test("an aborted sign-in stops polling", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    pollDeviceAuth(async () => new Response("", { status: 202 }), "c", controller.signal, {
      pollMs: 1,
    }),
    /取消/,
  );
});

test("an approval without a token is an error", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ status: "approved" }), { status: 200 });
  await assert.rejects(pollDeviceAuth(fetchImpl, "c", undefined, { pollMs: 1 }), /未返回 token/);
});
