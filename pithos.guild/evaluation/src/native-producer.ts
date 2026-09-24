// Pure candidate-v2 row construction. This does not open files, inspect a
// runtime, install a preload, authorize execution, or accept evidence.
export interface CandidateNativeProducerContext {
  trialId: string;
  configurationSha256: string;
  runtimeRequirementSha256: string;
  invocationDigest: string;
  supervisorPid: number;
  pid: number;
  ppid: number;
  actor: "parent" | "child";
}

const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const pid = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 2 && (value as number) <= 2147483647;
function freeze(value: any): any { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

export function createCandidateNativeEnvelope(context: CandidateNativeProducerContext, sequence: number, event: unknown) {
  try {
    if (!context || Object.keys(context).sort().join(",") !== "actor,configurationSha256,invocationDigest,pid,ppid,runtimeRequirementSha256,supervisorPid,trialId"
      || !uuid(context.trialId) || ![context.configurationSha256, context.runtimeRequirementSha256, context.invocationDigest].every(hash)
      || !pid(context.supervisorPid) || !pid(context.pid) || !pid(context.ppid) || context.pid === context.ppid
      || !["parent", "child"].includes(context.actor)
      || (context.actor === "parent" ? context.ppid !== context.supervisorPid : context.ppid === context.supervisorPid)
      || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 65535) throw Error();
    const serialized = JSON.stringify(event);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 1024 * 1024) throw Error();
    const retained = JSON.parse(serialized);
    if (!retained || typeof retained !== "object" || Array.isArray(retained) || typeof retained.type !== "string") throw Error();
    return freeze({ version: 2 as const, ...structuredClone(context), sequence, event: retained });
  } catch { throw new Error("Candidate native producer context mismatch"); }
}
