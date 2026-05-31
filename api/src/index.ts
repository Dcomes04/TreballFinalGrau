import { ENV } from './config/env';
import { createServer } from './server';
import { execSync } from 'node:child_process';

function freePortOnWindows(port: number): void {
  if (process.platform !== 'win32') return;
  if (ENV.NODE_ENV === 'production') return;

  // Find TCP listeners on the selected port and kill owning processes.
  // This avoids EADDRINUSE loops during local tsx watch sessions.
  let output = '';
  try {
    output = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    // findstr exits with code 1 when there are no matches.
    return;
  }

  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      pids.add(pid);
    }
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      console.info(`[API-BOOT] Port ${port}: process ${pid} terminated`);
    } catch {
      // Ignore if process has already exited.
    }
  }
}

const app = createServer();

freePortOnWindows(ENV.PORT);

app.listen(ENV.PORT, () => {
  console.log(`API running on http://localhost:${ENV.PORT}`);
  console.log(`Path: ${ENV.PATH}`);
});
