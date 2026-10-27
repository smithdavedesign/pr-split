// Runs the generated script for real (--execute). Besides git.js, the only module that starts a
// process: bash, on the exact script a dry run writes, so what was previewed is what runs.
import { spawn } from 'node:child_process';

/**
 * Runs `bash <scriptPath>` with PR_SPLIT_EXECUTE=1, streaming its output, and resolves with its
 * exit code. stdin is closed so a validation command can't hang waiting for input.
 */
export function runScript({ scriptPath, cwd, env, stdout, stderr }) {
  // Ctrl-C reaches bash too, and its failure handler cleans up and reports. Stay alive until it's
  // done, or the report would go to a closed pipe and kill the cleanup halfway.
  const keepRunning = () => {};
  process.on('SIGINT', keepRunning);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      cwd,
      env: { ...env, PR_SPLIT_EXECUTE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.write(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.write(chunk));
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error('bash is not installed or not on PATH') : err));
    child.on('close', (code) => resolve(code ?? 1));
  }).finally(() => process.off('SIGINT', keepRunning));
}
