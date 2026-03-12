# Context Injection Patterns

How to format each MCP tool's output for prompt injection. Use `<document index="n">` pattern for multiple snippets with relevance reasons.

## 1. search_codebase → `<codebase_context>`

Sort results by relevance score descending. Each snippet uses structured `<document>` tags with source, relevance score, and a reason explaining WHY this code matters for the task.

**Format:**
```xml
<codebase_context>
  <document index="1">
    <source>src/auth/token-manager.ts:45-72</source>
    <relevance>0.94</relevance>
    <reason>Contains the token refresh logic where the timeout bug likely originates</reason>
    <content>
export class TokenManager {
  private refreshToken(token: string): Promise<string> {
    // ... implementation
  }
}
    </content>
  </document>
  <document index="2">
    <source>src/middleware/auth-middleware.ts:12-28</source>
    <relevance>0.81</relevance>
    <reason>Calls TokenManager.refreshToken — may need updating if the fix changes the API</reason>
    <content>
export function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  // ... validation logic
}
    </content>
  </document>
</codebase_context>
```

**Rules:**
- Each snippet wrapped in `<document index="n">` with `<source>`, `<relevance>`, `<reason>`, `<content>`
- `<reason>` explains WHY this code is relevant to the specific task (not generic)
- Omit snippets below relevance 0.3 if budget is tight
- Preserve original indentation in `<content>`
- **Grounding:** quote relevant symbols from these snippets before reasoning about them

---

## 2. get_repo_map → `<repo_structure>`

Ranked file list with key exported symbols. Include dependency indicators.

**Format:**
```xml
<repo_structure>
src/auth/token-manager.ts  → exports: TokenManager, refreshToken
  ← imported by: src/middleware/auth-middleware.ts, src/api/user-routes.ts

src/middleware/auth-middleware.ts  → exports: authMiddleware
  ← imported by: src/app.ts

src/api/user-routes.ts  → exports: userRouter
  → imports: TokenManager (src/auth/token-manager.ts)
</repo_structure>
```

**Rules:**
- `→` means "imports / depends on"
- `←` means "imported by / depended upon by"
- List only files relevant to the query
- Include key exported symbols per file

---

## 3. get_recent_changes → `<recent_changes>`

Filter to changes relevant to the query topic. Format as chronological list.

**Format:**
```xml
<recent_changes>
- 1 day ago: Fix token expiry race condition in TokenManager (src/auth/token-manager.ts)
- 3 days ago: Add refresh token rotation (src/auth/token-manager.ts, src/db/token-store.ts)
- 5 days ago: Migrate auth middleware to async/await (src/middleware/auth-middleware.ts)
</recent_changes>
```

**Rules:**
- Format: `- N days/hours ago: description (files affected)`
- Show only changes touching files relevant to the query
- Keep descriptions concise (under 100 chars)
- Omit changes older than 30 days unless directly relevant

---

## 4. get_dependencies → `<dependencies>`

Tree-like import/dependent listing for the affected files.

**Format:**
```xml
<dependencies>
src/auth/token-manager.ts
  imports:
    - src/db/token-store.ts (TokenStore)
    - src/config/auth-config.ts (AUTH_SECRET, TOKEN_TTL)
  imported by:
    - src/middleware/auth-middleware.ts
    - src/api/user-routes.ts
    - src/tests/auth.test.ts
</dependencies>
```

**Rules:**
- Show one entry per relevant file
- List direct imports only (not transitive) unless requested
- Include the specific symbols imported in parentheses when available

---

## 5. get_file_summary → inline or standalone

Function/class outline. Use inline within `<codebase_context>` for single files, or standalone for review tasks.

**Format (inline):**
```xml
<codebase_context>
  <document index="1">
    <source>src/auth/token-manager.ts — outline</source>
    <reason>Full structural overview of the file under investigation</reason>
    <content>
class TokenManager
  + constructor(store: TokenStore, config: AuthConfig)
  + async generateToken(userId: string): Promise<string>
  + async refreshToken(token: string): Promise<string>
  + async revokeToken(token: string): Promise<void>
  - validatePayload(payload: TokenPayload): boolean  [private]
    </content>
  </document>
</codebase_context>
```

**Rules:**
- `+` public, `-` private, `#` protected
- One-line description per member when space allows
- Omit getters/setters unless they contain logic

---

## Before / After Examples

### Debug task — "Fix auth timeout bug"

**Before (raw prompt):**
```
Fix the auth timeout bug
```

**After (enhanced — deep intensity):**
```xml
<context_budget>
Total context budget: 4096 tokens
Allocation:
  - search_codebase: 2048 tokens (50%)
  - get_recent_changes: 1228 tokens (30%)
  - get_file_summary: 819 tokens (20%)
</context_budget>

<tool_rules>
Query the MCP codebase index server before generating code or explanations.
Primary tool: search_codebase(query="Fix the auth timeout bug")
Secondary tools: get_recent_changes, get_file_summary
</tool_rules>

<investigate_before_answering>
Never speculate about code you have not opened. Read the file before answering.
</investigate_before_answering>

<verification>
Before you finish, verify:
  1. The fix addresses the root cause, not just the symptom.
  2. Related call sites do not have the same bug.
  3. No existing tests regress.
  4. Your answer is grounded in actual code, not assumptions.
</verification>

<objective>
Identify and fix the root cause of the auth timeout bug. The deliverable is a minimal, correct code change that resolves the defect without breaking existing functionality. Success: the issue is resolved and all existing tests pass.
Original request: Fix the auth timeout bug
</objective>
```
