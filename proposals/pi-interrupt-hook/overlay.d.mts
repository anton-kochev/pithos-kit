import type * as ts from '../../pithos.guild/node_modules/typescript/lib/typescript.js';
export const trackedFiles: string[];
export const newFiles: string[];
export const files: string[];
export const protectedFiles: string[];
export function digests(installed: string): Record<string, string>;
export function qualifySource(source: string, proposal: string): void;
export function transpileOverlay(source: string, runtime: string, sandbox: string, compiler: typeof ts): Record<string, string>;
