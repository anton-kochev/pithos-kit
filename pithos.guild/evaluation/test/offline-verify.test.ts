import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { assertNetworkIsolation, runNetworkChecks, deniedSocket, loopbackControl, verifyNetworkTree, type NetworkState } from "../src/offline-verify.ts";

function state(): NetworkState {
  return { interfaces: { lo: [{ address: "127.0.0.1", internal: true }] }, routes4: "Iface\tDestination\tGateway\n", routes6: "", namespace: "net:[123]",
    status: "Uid:\t501\t501\t501\t501\nNoNewPrivs:\t1\n" + ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(key => `${key}:\t0000000000000000\n`).join("") };
}

test("standalone entrypoint refuses unexpected arguments or environment before socket checks", () => {
  for (const args of [["--unexpected"], ["--child"]]) {
    const result = spawnSync(process.execPath, [resolve("evaluation/src/offline-verify.ts"), ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/not-the-isolated-home" }, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, "");
    assert.match(result.stderr, /Offline verification failed/);
  }
});

test("requires an independently spawned child with matching namespace and complete denials", async () => {
  const checks = { state, loopback: async () => {}, denied: async () => "ENETUNREACH" };
  const child = { pid: 11, ppid: 10, checks: await runNetworkChecks(checks) };
  assert.equal((await verifyNetworkTree(checks, async () => JSON.stringify(child), 10)).child.pid, 11);
  for (const changed of [{ ...child, pid: 10 }, { ...child, ppid: 9 }, { ...child, checks: { ...child.checks, namespace: "net:[456]" } }, { ...child, checks: { ...child.checks, denials: [] } }]) {
    await assert.rejects(verifyNetworkTree(checks, async () => JSON.stringify(changed), 10), /Offline child verification mismatch/);
  }
});

test("socket adapter uses numeric documentation addresses, retains kernel errors and closes sockets", async () => {
  for (const protocol of ["tcp", "udp"] as const) for (const family of [4, 6] as const) {
    const calls: any[] = []; let closed = 0;
    const socket: any = new EventEmitter();
    socket.destroy = socket.close = () => { closed++; };
    socket.send = (bytes: Buffer, port: number, host: string, done: (err: any) => void) => { calls.push({ host, port, family }); queueMicrotask(() => done({ code: "ENETUNREACH" })); };
    const code = await deniedSocket(protocol, family, {
      tcp: (options: any) => { calls.push(options); queueMicrotask(() => socket.emit("error", { code: "ENETUNREACH" })); return socket; },
      udp: () => socket,
    });
    assert.equal(code, "ENETUNREACH"); assert.equal(closed, 1);
    assert.deepEqual(calls, [{ host: family === 4 ? "192.0.2.1" : "2001:db8::1", port: 9, family }]);
  }
});

test("positive socket control works using local loopback only", async () => {
  await loopbackControl();
});

test("requires working loopback and kernel rejection of both protocols/families; timeout is not proof", async () => {
  const calls: string[] = [];
  const result = await runNetworkChecks({ state, loopback: async () => { calls.push("loopback"); }, denied: async (protocol, family) => { calls.push(`${protocol}/${family}`); return "ENETUNREACH"; } });
  assert.deepEqual(calls, ["loopback", "tcp/4", "tcp/6", "udp/4", "udp/6"]);
  assert.equal(result.denials.length, 4);
  for (const error of ["ECONNREFUSED", "ETIMEDOUT", "connected", "EHOSTUNREACH"]) {
    await assert.rejects(runNetworkChecks({ state, loopback: async () => {}, denied: async () => error }), /Offline socket denial unverified/);
  }
  let reads = 0;
  await assert.rejects(runNetworkChecks({ state: () => ({ ...state(), namespace: `net:[${++reads}]` }), loopback: async () => {}, denied: async () => "ENETUNREACH" }), /Offline namespace changed/);
});

test("rejects connected or privileged state before any socket checks", async () => {
  for (const change of [
    (s: NetworkState) => s.interfaces.eth0 = [{ address: "172.17.0.2", internal: false }],
    (s: NetworkState) => s.routes4 += "eth0\t00000000\t010011AC\n",
    (s: NetworkState) => s.routes6 = "route via eth0",
    (s: NetworkState) => s.status = s.status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
    (s: NetworkState) => s.status = s.status.replace("CapBnd:\t0000000000000000", "CapBnd:\t0000000000000001"),
    (s: NetworkState) => s.status = s.status.replaceAll("501", "0"),
  ]) {
    const input = state(); change(input); let sockets = 0;
    await assert.rejects(runNetworkChecks({ state: () => input, loopback: async () => { sockets++; }, denied: async () => { sockets++; return "ENETUNREACH"; } }), /Offline network isolation mismatch/);
    assert.equal(sockets, 0);
  }
  assert.doesNotThrow(() => assertNetworkIsolation(state()));
});
