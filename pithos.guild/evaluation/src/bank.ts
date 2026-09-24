import { readFileSync } from "node:fs";
import { validateBank } from "./manifest.ts";

export function loadDevelopmentBank() {
  return validateBank(JSON.parse(readFileSync(new URL("../tasks/development.json", import.meta.url), "utf8")));
}

// Grader calibration only: never materialized inside agent-visible fixtures.
export const referenceFixes = [
  `export async function updateUser(actor, targetId, name, store) {
  if (!actor.id || (actor.id !== targetId && !(actor.admin === true))) throw new Error('Unauthorized');
  return store.save(targetId, name);
}\n`,
  `export async function updateUser(actor, targetId, name, store) {
  if (!actor.id) throw new Error('Unauthorized');
  if (actor.id === targetId) return store.save(targetId, name);
  if (actor.admin !== true) throw new Error('Forbidden');
  return await store.save(targetId, name);
}\n`,
];
