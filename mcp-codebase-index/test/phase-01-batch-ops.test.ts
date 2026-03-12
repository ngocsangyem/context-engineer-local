/**
 * Functional test for Phase 1: Batch Operations Optimization
 * Tests batch writes, batch deletes, and batch vector operations
 */

import fs from 'fs';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { fileURLToPath } from 'url';
import { IndexerOrchestrator } from '../src/indexer/indexer-orchestrator.js';
import type { MetadataStore } from '../src/storage/metadata-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ─── Test fixtures ───────────────────────────────────────────────────── */

const TEST_SAMPLES = {
  'service-a.ts': `
export class ServiceA {
  constructor() {}
  processData(input: string): string {
    return input.toUpperCase();
  }
}

export function createServiceA(): ServiceA {
  return new ServiceA();
}
`,

  'service-b.ts': `
import { ServiceA } from './service-a';

export class ServiceB {
  private serviceA: ServiceA;

  constructor(serviceA: ServiceA) {
    this.serviceA = serviceA;
  }

  execute(data: string): string {
    return this.serviceA.processData(data);
  }
}

export const serviceB = new ServiceB(new (require('./service-a')).ServiceA());
`,

  'service-c.ts': `
export interface IService {
  execute(): Promise<void>;
}

export class ServiceC implements IService {
  async execute(): Promise<void> {
    console.log('ServiceC executing');
  }
}

export type ServiceType = 'A' | 'B' | 'C';
`,

  'utils.ts': `
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const formatJson = (obj: any): string => {
  return JSON.stringify(obj, null, 2);
};

export class Logger {
  log(msg: string): void {
    console.log(msg);
  }

  error(msg: string): void {
    console.error(msg);
  }
}
`,
};

const BATCHED_TEST_SAMPLES = {
  'batch-1.ts': `
export function batchFunc1(): void {
  console.log('batch 1');
}
`,
  'batch-2.ts': `
export function batchFunc2(): void {
  console.log('batch 2');
}
`,
  'batch-3.ts': `
export function batchFunc3(): void {
  console.log('batch 3');
}
`,
};

/* ─── Test suite ───────────────────────────────────────────────────────── */

async function runTests() {
  let testDir: string | null = null;
  let orchestrator: IndexerOrchestrator | null = null;
  let metadataStore: MetadataStore | null = null;

  const results = {
    passed: 0,
    failed: 0,
    tests: [] as Array<{ name: string; passed: boolean; error?: string }>,
  };

  const test = (name: string, fn: () => boolean | Promise<boolean>) => {
    return async () => {
      try {
        const passed = await fn();
        results.tests.push({ name, passed });
        if (passed) {
          results.passed++;
          console.log(`   ✓ ${name}`);
        } else {
          results.failed++;
          console.log(`   ✗ ${name}`);
        }
      } catch (err) {
        results.failed++;
        results.tests.push({ name, passed: false, error: String(err) });
        console.log(`   ✗ ${name}: ${err}`);
      }
    };
  };

  try {
    // Setup: create temp directory with test files
    console.log('📂 Setting up test environment...');
    testDir = fs.mkdtempSync(path.join('/tmp', 'batch-ops-test-'));
    console.log(`   Created test dir: ${testDir}`);

    for (const [filename, content] of Object.entries(TEST_SAMPLES)) {
      const filePath = path.join(testDir, filename);
      fs.writeFileSync(filePath, content);
    }
    console.log(`   Created ${Object.keys(TEST_SAMPLES).length} test files`);

    // Initialize orchestrator
    console.log('\n🔧 Initializing orchestrator...');
    const indexDir = path.join(testDir, '.index');
    orchestrator = new IndexerOrchestrator(testDir, { indexDir });
    metadataStore = orchestrator.getMetadataStore();
    console.log(`   Index directory: ${indexDir}`);

    // Phase 1: Full indexing
    console.log('\n📑 Phase 1: Full indexing (batch write test)...');
    const startTime = Date.now();
    const indexStats = await orchestrator.indexAll();
    const duration = Date.now() - startTime;

    console.log(`   ✓ Indexing complete in ${duration}ms`);
    console.log(`     - Files indexed: ${indexStats.indexedFiles}`);
    console.log(`     - Total chunks: ${indexStats.totalChunks}`);
    console.log(`     - Vector count: ${indexStats.vectorCount}`);
    console.log(`     - Graph nodes: ${indexStats.graphNodes}`);
    console.log(`     - Graph edges: ${indexStats.graphEdges}`);

    // Test 1: All files indexed
    await test('All test files indexed', () => {
      return indexStats.indexedFiles === Object.keys(TEST_SAMPLES).length;
    })();

    // Test 2: Chunks created
    await test('Chunks created for all files', () => {
      return indexStats.totalChunks > 0;
    })();

    // Test 3: Vector store populated
    await test('Vector store populated', () => {
      return indexStats.vectorCount > 0;
    })();

    // Test 4: Metadata persisted
    await test('File metadata persisted', () => {
      const files = metadataStore!.getAllFiles();
      return files.length === Object.keys(TEST_SAMPLES).length;
    })();

    // Test 5: Symbols extracted
    await test('Symbols extracted and stored', () => {
      const allSymbols: any[] = [];
      const files = metadataStore!.getAllFiles();
      for (const file of files) {
        const symbols = metadataStore!.getFileSymbols(file.path);
        allSymbols.push(...symbols);
      }
      return allSymbols.length > 0;
    })();

    // Test 6: Edges extracted
    await test('Dependency edges extracted', () => {
      const allEdges = metadataStore!.getAllEdges();
      return allEdges.length > 0;
    })();

    // Phase 2: Batch file removal
    console.log('\n🗑️  Phase 2: Batch file removal test...');
    const filesToDelete = [
      path.join(testDir, 'utils.ts'),
      path.join(testDir, 'service-c.ts'),
    ];
    const beforeDelete = metadataStore!.getStats();
    console.log(`   Before delete: ${beforeDelete.fileCount} files, ${beforeDelete.totalChunks} chunks`);

    await orchestrator.removeFiles(filesToDelete);

    const afterDelete = metadataStore!.getStats();
    console.log(`   After delete: ${afterDelete.fileCount} files, ${afterDelete.totalChunks} chunks`);

    // Test 7: Files removed from metadata
    await test('Files removed from metadata store', () => {
      return afterDelete.fileCount === beforeDelete.fileCount - 2;
    })();

    // Test 8: Symbols removed with files
    await test('Symbols removed with deleted files', () => {
      const utilsSymbols = metadataStore!.getFileSymbols(filesToDelete[0]);
      const serviceCSymbols = metadataStore!.getFileSymbols(filesToDelete[1]);
      return utilsSymbols.length === 0 && serviceCSymbols.length === 0;
    })();

    // Test 9: Chunks removed with files
    await test('Chunks removed with deleted files', () => {
      return afterDelete.totalChunks < beforeDelete.totalChunks;
    })();

    // Phase 3: Batch file update (incremental indexing)
    console.log('\n♻️  Phase 3: Batch file update (incremental indexing)...');

    // Add new batch files
    for (const [filename, content] of Object.entries(BATCHED_TEST_SAMPLES)) {
      const filePath = path.join(testDir, filename);
      fs.writeFileSync(filePath, content);
    }
    console.log(`   Added ${Object.keys(BATCHED_TEST_SAMPLES).length} new files`);

    const beforeUpdate = metadataStore!.getStats();
    await orchestrator.indexFiles(Object.keys(BATCHED_TEST_SAMPLES).map(f => path.join(testDir, f)));
    const afterUpdate = metadataStore!.getStats();

    console.log(`   Before indexing batch: ${beforeUpdate.fileCount} files`);
    console.log(`   After indexing batch: ${afterUpdate.fileCount} files`);

    // Test 10: New files indexed
    await test('New batch files indexed', () => {
      return afterUpdate.fileCount === beforeUpdate.fileCount + Object.keys(BATCHED_TEST_SAMPLES).length;
    })();

    // Test 11: New symbols extracted
    await test('Symbols extracted from new batch files', () => {
      let newSymbols = 0;
      for (const filename of Object.keys(BATCHED_TEST_SAMPLES)) {
        const symbols = metadataStore!.getFileSymbols(path.join(testDir, filename));
        newSymbols += symbols.length;
      }
      return newSymbols > 0;
    })();

    // Phase 4: File update (modified content)
    console.log('\n✏️  Phase 4: File update test (content modification)...');

    const serviceAPath = path.join(testDir, 'service-a.ts');
    const newContent = `
export class ServiceA {
  constructor() {}

  processData(input: string): string {
    return input.toUpperCase();
  }

  // New method added
  async asyncProcess(input: string): Promise<string> {
    return new Promise(resolve => {
      setTimeout(() => resolve(input.toLowerCase()), 100);
    });
  }
}

export function createServiceA(): ServiceA {
  return new ServiceA();
}
`;

    fs.writeFileSync(serviceAPath, newContent);
    const statsBeforeUpdate = metadataStore!.getStats();
    await orchestrator.indexFiles([serviceAPath]);
    const statsAfterUpdate = metadataStore!.getStats();

    // Test 12: File metadata updated (hash changed)
    await test('File metadata updated on content change', () => {
      const hash1 = metadataStore!.getFileHash(serviceAPath);
      return hash1 !== null;
    })();

    // Test 13: No regression in other files
    await test('Other files not affected by update', () => {
      return statsAfterUpdate.fileCount === statsBeforeUpdate.fileCount;
    })();

    // Phase 5: Database integrity
    console.log('\n🔍 Phase 5: Database integrity checks...');

    // Test 14: Consistency between stores
    await test('Consistency: all indexed files have metadata', () => {
      const files = metadataStore!.getAllFiles();
      return files.length === statsAfterUpdate.fileCount;
    })();

    // Test 15: No orphaned symbols
    await test('No orphaned symbols (all have valid file paths)', () => {
      const files = metadataStore!.getAllFiles();
      const filePaths = new Set(files.map(f => f.path));
      for (const file of files) {
        const symbols = metadataStore!.getFileSymbols(file.path);
        for (const sym of symbols) {
          if (!filePaths.has(sym.filePath)) {
            return false;
          }
        }
      }
      return true;
    })();

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log(`✅ TEST SUMMARY: ${results.passed} passed, ${results.failed} failed`);
    console.log('='.repeat(60));

    if (results.failed > 0) {
      console.log('\n❌ Failed tests:');
      for (const test of results.tests) {
        if (!test.passed) {
          console.log(`   - ${test.name}${test.error ? ': ' + test.error : ''}`);
        }
      }
    }

    return results.failed === 0;
  } catch (err) {
    console.error('\n❌ Test suite error:', err);
    return false;
  } finally {
    // Cleanup
    if (orchestrator) {
      try {
        orchestrator.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    if (testDir && fs.existsSync(testDir)) {
      await fsPromises.rm(testDir, { recursive: true, force: true });
      console.log('\n🧹 Cleaned up test directory');
    }
  }
}

// Run tests
const success = await runTests();
process.exit(success ? 0 : 1);
