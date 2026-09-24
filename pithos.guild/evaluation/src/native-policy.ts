// Versioned campaign requirements, not configuration, observed provenance or
// authorization. A new reviewed policy must get a new revision, not edit v1.
import { isDeepStrictEqual } from "node:util";

export const NATIVE_POLICY_V1 = Object.freeze({
  version: 1,
  node: "v24.20.0",
  pi: "0.85.1",
  piAi: "0.85.1",
  model: "openai-codex/gpt-6-astra",
  api: "openai-codex-responses",
  thinking: "high",
  serviceTier: "base",
  transport: "auto",
  authentication: "scoped-codex-access-only",
  evidence: "native-v1",
} as const);
// Unreviewed development candidate. Its distinct revision/evidence label prevents
// candidate receipts from being represented as evidence under immutable v1.
export const CANDIDATE_NATIVE_POLICY_V2 = Object.freeze({
  ...NATIVE_POLICY_V1,
  version: 2,
  evidence: "candidate-native-v2",
} as const);
// Owner-authorized runtime requirement migration only; unreviewed/unadmitted.
// V2 remains a historical identity. Evidence envelope schema is unchanged.
export const CANDIDATE_NATIVE_POLICY_V3 = Object.freeze({
  ...CANDIDATE_NATIVE_POLICY_V2, version: 3, pi: "0.87.0", piAi: "0.87.0",
} as const);
export type NativePolicy = typeof NATIVE_POLICY_V1 | typeof CANDIDATE_NATIVE_POLICY_V2 | typeof CANDIDATE_NATIVE_POLICY_V3;
export function validateNativePolicy(raw: unknown): NativePolicy {
  const policy = isDeepStrictEqual(raw, NATIVE_POLICY_V1) ? NATIVE_POLICY_V1
    : isDeepStrictEqual(raw, CANDIDATE_NATIVE_POLICY_V2) ? CANDIDATE_NATIVE_POLICY_V2
    : isDeepStrictEqual(raw, CANDIDATE_NATIVE_POLICY_V3) ? CANDIDATE_NATIVE_POLICY_V3 : undefined;
  if (!policy) throw new Error("Invalid native policy");
  return structuredClone(policy);
}
