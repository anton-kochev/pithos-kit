import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Applied } from './apply.ts';
import type { WorkerResult } from './worker.ts';

export function progressLine(phase: string, elapsed: number, model: string, thinking: string, width: number): string {
  return truncateToWidth(`Clio · ${phase} · ${Math.floor(elapsed / 1000)}s · ${model} / ${thinking}`, width);
}
export function progress(ctx: ExtensionContext, model: string, thinking: string) {
  const start = Date.now();
  let phase = 'reading context';
  const show = () => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('clio', (_tui, theme) => ({
      render: width => [theme.fg('muted', progressLine(phase, Date.now() - start, model, thinking, width))],
      invalidate() {},
    }));
  };
  const timer = ctx.mode === 'tui' ? setInterval(show, 1000) : undefined;
  show();
  return {
    phase(value: string) { phase = value; show(); },
    stop() { if (timer) clearInterval(timer); if (ctx.mode === 'tui') ctx.ui.setWidget('clio', undefined); },
  };
}
export function completion(applied: Applied, elapsed: number, worker: WorkerResult | undefined, observed: string[]): string | undefined {
  if (!applied.changed.length && !applied.uncertain.length && !applied.problems.length && !applied.createdDirectories?.length && !applied.leftoverTemps?.length) return;
  const estimate = worker?.usage?.cost.total;
  const cost = typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0 ? `~$${estimate.toFixed(4)}${worker?.problem || worker?.usageStatus === 'partial' ? ' (partial)' : ''}` : 'cost unknown';
  const changes = applied.uncertain.length ? `${applied.changed.length} files confirmed changed · ${applied.uncertain.length} possibly modified` : `${applied.changed.length} files changed`;
  return [`Clio · ${Math.floor(elapsed / 1000)}s · ${cost} · ${applied.documented.length} findings captured · ${changes} · ${applied.problems.length} unresolved`,
    ...applied.documented.map(i => `- ${worker?.proposal?.findings[i]?.claim ?? 'Finding'} (${worker?.proposal?.findings[i]?.sources.map(s => `${'path' in s ? s.path : `session:${s.entryId}`}:${s.startLine}-${s.endLine}`).join(', ')})`),
    ...(applied.changed.length ? [`Changed: ${applied.changed.join(', ')}`] : []),
    ...(applied.uncertain.length ? [`Possibly modified (unverified): ${applied.uncertain.join(', ')}`] : []),
    ...(applied.createdDirectories?.length ? [`Created directories: ${applied.createdDirectories.join(', ')}`] : []),
    ...(applied.leftoverTemps?.length ? [`Leftover temporary files: ${applied.leftoverTemps.join(', ')}`] : []),
    ...(observed.length ? [`Observed: ${observed.join(', ')}`] : []),
    ...applied.problems.map(p => `Unresolved: ${p}`),
  ].join('\n');
}
