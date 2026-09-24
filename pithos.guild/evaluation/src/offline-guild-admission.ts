export function admitGuildActor(config: any, readiness: any, state: { namespace: string; uid: number }, pid: number, ppid: number, parent?: any): "parent" | "child" {
  try {
    if (config.arm !== "guild-available" || config.directory !== "/evidence/synthetic-guild/native" || config.launchParentPid !== readiness.parent.pid
      || state.namespace !== readiness.parent.checks.namespace || state.uid !== readiness.parent.checks.uid
      || !Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(ppid) || ppid <= 1 || pid === ppid) throw Error();
    if (ppid === config.launchParentPid && parent === undefined) return "parent";
    if (!parent || parent.pid !== ppid || parent.ppid !== config.launchParentPid || parent.namespace !== state.namespace || parent.uid !== state.uid) throw Error();
    return "child";
  } catch { throw new Error("Synthetic Guild ancestry mismatch"); }
}
