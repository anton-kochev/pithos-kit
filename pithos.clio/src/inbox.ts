import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Change } from './gate.ts';

export interface InboxItem {
  id: string;
  createdAt: string;
  /** Commit range the change came from. */
  range: string;
  reason: string;
  change: Change;
}

/** Changes waiting for review, stored under the common git dir so every worktree and session sees them. */
export class Inbox {
  readonly dir: string;

  constructor(clioDir: string) {
    this.dir = join(clioDir, 'inbox');
  }

  async add(range: string, reason: string, change: Change): Promise<InboxItem> {
    await mkdir(this.dir, { recursive: true });
    const item: InboxItem = { id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), range, reason, change };
    await writeFile(join(this.dir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, { flag: 'wx' });
    return item;
  }

  async list(): Promise<InboxItem[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    const items: InboxItem[] = [];
    for (const name of names.filter(n => n.endsWith('.json')).sort()) {
      try { items.push(JSON.parse(await readFile(join(this.dir, name), 'utf8')) as InboxItem); } catch { /* skip unreadable items */ }
    }
    return items;
  }

  async remove(id: string): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(id)) return;
    await rm(join(this.dir, `${id}.json`), { force: true });
  }
}
