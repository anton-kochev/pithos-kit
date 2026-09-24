import { readFileSync, readlinkSync } from "node:fs";
import { networkInterfaces } from "node:os";

export function currentNetworkState(): NetworkState {
  return { interfaces: networkInterfaces(), routes4: readFileSync("/proc/net/route", "utf8"), routes6: readFileSync("/proc/net/ipv6_route", "utf8"),
    status: readFileSync("/proc/self/status", "utf8"), namespace: readlinkSync("/proc/self/ns/net") };
}
export interface NetworkState {
  interfaces: Record<string, { address: string; internal: boolean }[] | undefined>;
  routes4: string; routes6: string; status: string; namespace: string;
}
export function assertNetworkIsolation(state: NetworkState) {
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(state.status);
  if (!uid || uid[1] === "0" || !uid.slice(1).every(value => value === uid[1]) || !/^NoNewPrivs:\s+1$/m.test(state.status)
    || !["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(key => new RegExp(`^${key}:\\s+0+$`, "m").test(state.status))
    || !/^net:\[\d+\]$/.test(state.namespace) || Object.keys(state.interfaces).join() !== "lo"
    || !state.interfaces.lo?.length || !state.interfaces.lo.every(info => info.internal && ["127.0.0.1", "::1"].includes(info.address))
    || !/^Iface\s+Destination\s+Gateway/.test(state.routes4) || state.routes4.trim().split("\n").length !== 1
    || state.routes6.trim().split("\n").filter(Boolean).some(line => { const columns = line.trim().split(/\s+/); return columns.length !== 10 || columns[9] !== "lo"; })) throw new Error("Offline network isolation mismatch");
  return { namespace: state.namespace, uid: Number(uid[1]) };
}
