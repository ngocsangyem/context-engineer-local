/**
 * Functional test for Symbol Index Enhancement (Phase 3)
 * Tests symbol extraction, persistence, and querying across a mini codebase
 */

import fs from 'fs';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { fileURLToPath } from 'url';
import { IndexerOrchestrator } from '../src/indexer/indexer-orchestrator.js';
import type { MetadataStore } from '../src/storage/metadata-store.js';
import type { SymbolRecord } from '../src/models/symbol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ─── Test fixtures ───────────────────────────────────────────────────── */

const TEST_SAMPLES = {
  'auth-service.ts': `
export class AuthService {
  private secret: string = 'secret';

  constructor(secret: string) {
    this.secret = secret;
  }

  authenticate(token: string): Promise<boolean> {
    return Promise.resolve(!!token);
  }

  validateToken(token: string, issuer?: string): boolean {
    return token.length > 0;
  }
}

export function createAuthService(secret: string): AuthService {
  return new AuthService(secret);
}

export interface TokenPayload {
  sub: string;
  iss: string;
  exp: number;
}
`,

  'user-controller.ts': `
export class UserController {
  private authService: any;

  constructor(authService: any) {
    this.authService = authService;
  }

  async getUser(userId: string): Promise<any> {
    return { id: userId, name: 'John Doe' };
  }

  updateUser(userId: string, data: any): boolean {
    return true;
  }
}

export type UserRole = 'admin' | 'user' | 'guest';

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  BANNED = 'banned',
}
`,

  'utils.ts': `
const API_BASE = 'https://api.example.com';

export function formatDate(date: Date, format: string = 'YYYY-MM-DD'): string {
  return new Intl.DateTimeFormat().format(date);
}

export const parseJSON = (input: string) => {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
};

interface Logger {
  log(msg: string): void;
}

export class ConsoleLogger implements Logger {
  log(msg: string): void {
    console.log(msg);
  }

  debug(msg: string, data?: any): void {
    if (process.env.DEBUG) console.log(msg, data);
  }
}
`,
};

/* ─── Test suite ───────────────────────────────────────────────────────── */

async function runTests() {
  let testDir: string | null = null;
  let orchestrator: IndexerOrchestrator | null = null;
  let metadataStore: MetadataStore | null = null;

  try {
    // Setup: create temp directory with test files
    console.log('📂 Setting up test environment...');
    testDir = fs.mkdtempSync(path.join('/tmp', 'symbol-test-'));
    console.log(`   Created test dir: ${testDir}`);

    for (const [filename, content] of Object.entries(TEST_SAMPLES)) {
      const filePath = path.join(testDir, filename);
      fs.writeFileSync(filePath, content);
    }
    console.log(`   Created ${Object.keys(TEST_SAMPLES).length} test files`);

    // Initialize indexer
    console.log('\n🔧 Initializing indexer...');
    const indexDir = path.join(testDir, '.index');
    fs.mkdirSync(indexDir, { recursive: true });
    orchestrator = new IndexerOrchestrator(indexDir);
    metadataStore = orchestrator.getMetadataStore();
    console.log(`   Index directory: ${indexDir}`);

    // Index the test files
    console.log('\n📑 Running indexer...');
    const startTime = Date.now();
    const result = await orchestrator.indexDirectory(testDir);
    const duration = Date.now() - startTime;
    console.log(`   Indexed ${result.processedCount} files in ${duration}ms`);
    console.log(`   Total symbols extracted: ${result.totalSymbols ?? 0}`);

    // Run test suites
    let passCount = 0;
    let failCount = 0;

    // Test 1: Function symbols
    console.log('\n🧪 Test 1: Function symbols extraction');
    {
      const funcs = metadataStore!.searchSymbols('authenticate', 'function');
      if (funcs.length > 0 && funcs[0].name === 'authenticate') {
        console.log('   ✓ Found authenticate function');
        console.log(`     - Signature: ${funcs[0].signature}`);
        console.log(`     - Visibility: ${funcs[0].visibility}`);
        passCount++;
      } else {
        console.log('   ✗ Failed to find authenticate function');
        failCount++;
      }
    }

    // Test 2: Class symbols
    console.log('\n🧪 Test 2: Class symbols extraction');
    {
      const classes = metadataStore!.searchSymbols('AuthService', 'class');
      if (classes.length > 0 && classes[0].name === 'AuthService') {
        console.log('   ✓ Found AuthService class');
        console.log(`     - Qualified name: ${classes[0].qualifiedName}`);
        console.log(`     - Visibility: ${classes[0].visibility}`);
        passCount++;
      } else {
        console.log('   ✗ Failed to find AuthService class');
        failCount++;
      }
    }

    // Test 3: Method symbols with parent relationship
    console.log('\n🧪 Test 3: Method symbols and parent relationships');
    {
      const methods = metadataStore!.searchSymbols('validateToken', 'method');
      if (methods.length > 0) {
        const method = methods[0];
        console.log('   ✓ Found validateToken method');
        console.log(`     - Parent symbol: ${method.parentSymbol}`);
        console.log(`     - Qualified name: ${method.qualifiedName}`);
        if (method.parentSymbol === 'AuthService') {
          console.log('   ✓ Parent relationship correct');
          passCount++;
        } else {
          console.log('   ✗ Parent relationship incorrect');
          failCount++;
        }
      } else {
        console.log('   ✗ Failed to find method');
        failCount++;
      }
    }

    // Test 4: Exported symbols visibility
    console.log('\n🧪 Test 4: Exported symbols visibility tracking');
    {
      const exported = metadataStore!.searchSymbols('createAuthService', 'function');
      if (exported.length > 0 && exported[0].visibility === 'exported') {
        console.log('   ✓ Found exported function with correct visibility');
        passCount++;
      } else {
        console.log('   ✗ Visibility tracking failed');
        failCount++;
      }
    }

    // Test 5: Interface symbols
    console.log('\n🧪 Test 5: Interface symbols extraction');
    {
      const ifaces = metadataStore!.searchSymbols('TokenPayload', 'interface');
      if (ifaces.length > 0 && ifaces[0].name === 'TokenPayload') {
        console.log('   ✓ Found TokenPayload interface');
        console.log(`     - Kind: ${ifaces[0].kind}`);
        passCount++;
      } else {
        console.log('   ✗ Failed to find interface');
        failCount++;
      }
    }

    // Test 6: Type aliases
    console.log('\n🧪 Test 6: Type alias symbols');
    {
      const types = metadataStore!.searchSymbols('UserRole', 'type');
      if (types.length > 0 && types[0].name === 'UserRole') {
        console.log('   ✓ Found UserRole type alias');
        passCount++;
      } else {
        console.log('   ✗ Failed to find type alias');
        failCount++;
      }
    }

    // Test 7: Enum symbols
    console.log('\n🧪 Test 7: Enum symbols extraction');
    {
      const enums = metadataStore!.searchSymbols('UserStatus', 'enum');
      if (enums.length > 0 && enums[0].name === 'UserStatus') {
        console.log('   ✓ Found UserStatus enum');
        passCount++;
      } else {
        console.log('   ✗ Failed to find enum');
        failCount++;
      }
    }

    // Test 8: Parameter extraction
    console.log('\n🧪 Test 8: Function parameter extraction');
    {
      const funcs = metadataStore!.searchSymbols('authenticate', 'method');
      if (funcs.length > 0 && funcs[0].parameters) {
        const params = funcs[0].parameters;
        console.log('   ✓ Found parameters for authenticate method');
        console.log(`     - Parameter count: ${params.length}`);
        params.forEach((p) => {
          console.log(`       • ${p.name}${p.type ? `: ${p.type}` : ''}`);
        });
        passCount++;
      } else {
        console.log('   ✗ Failed to extract parameters');
        failCount++;
      }
    }

    // Test 9: File-specific symbol query
    console.log('\n🧪 Test 9: File-specific symbol queries');
    {
      const authServiceFile = path.join(testDir, 'auth-service.ts');
      const fileSymbols = metadataStore!.getFileSymbols(authServiceFile);
      console.log(`   Found ${fileSymbols.length} symbols in auth-service.ts`);
      if (fileSymbols.length >= 3) {
        console.log('   ✓ File symbols query returned expected count');
        fileSymbols.slice(0, 3).forEach((s) => {
          console.log(`     - ${s.kind}: ${s.name}`);
        });
        passCount++;
      } else {
        console.log(`   ✗ Expected >=3 symbols, got ${fileSymbols.length}`);
        failCount++;
      }
    }

    // Test 10: Symbol removal on file delete
    console.log('\n🧪 Test 10: Symbol removal on file deletion');
    {
      const utilsFile = path.join(testDir, 'utils.ts');
      const beforeDelete = metadataStore!.getFileSymbols(utilsFile);
      console.log(`   Symbols in utils.ts before delete: ${beforeDelete.length}`);

      metadataStore!.removeSymbols(utilsFile);
      const afterDelete = metadataStore!.getFileSymbols(utilsFile);
      console.log(`   Symbols in utils.ts after delete: ${afterDelete.length}`);

      if (beforeDelete.length > 0 && afterDelete.length === 0) {
        console.log('   ✓ Symbol removal works correctly');
        passCount++;
      } else {
        console.log('   ✗ Symbol removal failed');
        failCount++;
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log(`✅ SUMMARY: ${passCount} passed, ${failCount} failed`);
    console.log('='.repeat(60));

    return failCount === 0;
  } catch (err) {
    console.error('\n❌ Test suite error:', err);
    return false;
  } finally {
    // Cleanup
    if (orchestrator) {
      orchestrator.close();
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
