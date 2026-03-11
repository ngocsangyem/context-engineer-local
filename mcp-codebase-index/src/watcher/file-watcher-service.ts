/**
 * File watcher service using @parcel/watcher.
 * Debounces change events and triggers incremental re-indexing.
 */

import * as parcelWatcher from '@parcel/watcher';
import path from 'path';
import type { IndexerOrchestrator } from '../indexer/indexer-orchestrator.js';
import type { GitignoreFilter } from '../utils/gitignore-filter.js';

const DEBOUNCE_MS = 300;

type WatcherSubscription = { unsubscribe(): Promise<void> };

export class FileWatcherService {
  private subscription: WatcherSubscription | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending changes grouped by event type */
  private pendingChanged: Set<string> = new Set();
  private pendingDeleted: Set<string> = new Set();

  constructor(
    private readonly rootPath: string,
    private readonly orchestrator: IndexerOrchestrator,
    private readonly gitignoreFilter: GitignoreFilter
  ) {}

  /** Start watching the root directory for file changes. */
  async start(): Promise<void> {
    if (this.subscription) return;

    this.subscription = await parcelWatcher.subscribe(
      this.rootPath,
      (err, events) => {
        if (err) {
          process.stderr.write(`[watcher] Error: ${err}\n`);
          return;
        }
        this.handleEvents(events);
      },
      { ignore: ['**/.index/**', '**/node_modules/**', '**/.git/**'] }
    );

    process.stderr.write(`[watcher] Watching: ${this.rootPath}\n`);
  }

  /** Stop the file watcher and clear pending state. */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    process.stderr.write('[watcher] Stopped.\n');
  }

  /** Collect events into pending sets; reset debounce timer on each batch. */
  private handleEvents(events: parcelWatcher.Event[]): void {
    for (const event of events) {
      const relPath = path.relative(this.rootPath, event.path);

      // Skip gitignored paths
      if (this.gitignoreFilter.isIgnored(relPath)) continue;

      if (event.type === 'delete') {
        this.pendingDeleted.add(event.path);
        this.pendingChanged.delete(event.path);
      } else {
        // 'create' | 'update'
        this.pendingChanged.add(event.path);
        this.pendingDeleted.delete(event.path);
      }
    }

    // Reset debounce window
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  /** Process accumulated changes after debounce window expires. */
  private async flush(): Promise<void> {
    const changed = [...this.pendingChanged];
    const deleted = [...this.pendingDeleted];
    this.pendingChanged.clear();
    this.pendingDeleted.clear();

    if (changed.length === 0 && deleted.length === 0) return;

    try {
      if (changed.length > 0) {
        await this.orchestrator.indexFiles(changed);
      }
      if (deleted.length > 0) {
        await this.orchestrator.removeFiles(deleted);
      }
      process.stderr.write(
        `[watcher] Re-indexed ${changed.length} files, removed ${deleted.length} files\n`
      );
    } catch (err) {
      process.stderr.write(`[watcher] Flush error: ${err}\n`);
    }
  }
}
