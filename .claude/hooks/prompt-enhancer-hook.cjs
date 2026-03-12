#!/usr/bin/env node
/**
 * Prompt Enhancer Hook — UserPromptSubmit
 *
 * Detects --enhancer flag in user prompts, runs enhance-prompt.py,
 * and injects the enhanced prompt for Claude to review with the user.
 *
 * Exit 0 always (non-blocking). Enhanced prompt injected via stdout.
 */

try {
  const { execSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  // Read the user's prompt from stdin (Claude Code pipes it)
  const input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  const userPrompt = input.prompt || '';

  // Only activate if --enhancer flag is present
  if (!userPrompt.includes('--enhancer')) {
    process.exit(0);
  }

  // Strip the --enhancer flag from the prompt
  const cleanPrompt = userPrompt.replace(/\s*--enhancer\s*/g, ' ').trim();
  if (!cleanPrompt) {
    process.exit(0);
  }

  // Find the enhance-prompt.py script relative to this hook
  const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..');
  const scriptPaths = [
    path.join(projectDir, '.claude', 'skills', 'prompt-enhancer', 'scripts', 'enhance-prompt.py'),
    path.join(projectDir, 'skills', 'prompt-enhancer', 'scripts', 'enhance-prompt.py'),
  ];
  const scriptPath = scriptPaths.find(p => fs.existsSync(p));
  if (!scriptPath) {
    process.exit(0); // Script not found, skip silently
  }

  // Find Python interpreter (prefer venv)
  const venvPython = path.join(projectDir, '.claude', 'skills', '.venv', 'bin', 'python3');
  const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python3';

  // Run the enhancement script
  let enhanced;
  try {
    const escaped = cleanPrompt.replace(/'/g, "'\\''");
    enhanced = execSync(
      `${pythonCmd} "${scriptPath}" '${escaped}'`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch (err) {
    // Script failed — skip enhancement, let Claude handle raw prompt
    process.exit(0);
  }

  if (!enhanced || enhanced.length < 50) {
    process.exit(0);
  }

  // Inject the enhanced prompt for Claude to present to the user
  console.log(`<prompt-enhancer-result>
The user's prompt was enhanced via the prompt-enhancer skill.

IMPORTANT: Before proceeding, you MUST:
1. Show the enhanced prompt below to the user
2. Ask them: "Here is the enhanced prompt. Would you like to use it as-is, modify it, or skip enhancement?"
3. Use AskUserQuestion with options: "Use as-is", "Let me modify it", "Skip enhancement"
4. If "Use as-is": follow the enhanced prompt as your working instructions
5. If "Let me modify it": let the user edit, then use their version
6. If "Skip enhancement": use the original prompt: ${cleanPrompt}

Original prompt: ${cleanPrompt}

Enhanced prompt:
${enhanced}
</prompt-enhancer-result>`);

} catch (e) {
  // Never block the user — exit cleanly on any error
  process.exit(0);
}
