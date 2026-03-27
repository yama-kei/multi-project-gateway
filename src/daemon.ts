import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { unitFileName, generateUnitFile } from './systemd.js';

export function resolveServiceDir(): string {
  return resolve(homedir(), '.config', 'systemd', 'user');
}

export function resolveServicePath(profile?: string): string {
  return resolve(resolveServiceDir(), unitFileName(profile));
}

export function daemonInstall(profile?: string): void {
  const serviceDir = resolveServiceDir();
  mkdirSync(serviceDir, { recursive: true });

  const nodePath = process.execPath;
  const mpgPath = resolveOwnBinary();

  const unit = generateUnitFile({ nodePath, mpgPath, profile });
  const servicePath = resolveServicePath(profile);
  writeFileSync(servicePath, unit);

  const name = unitFileName(profile);

  // Enable lingering so service runs without login session
  try {
    execFileSync('loginctl', ['enable-linger'], { stdio: 'ignore' });
  } catch {
    // Non-fatal — may already be enabled or not available
  }

  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', '--now', name], { stdio: 'inherit' });

  console.log(`Installed and started ${name}`);
  console.log(`  Unit file: ${servicePath}`);
  console.log(`  Status:    systemctl --user status ${name}`);
  console.log(`  Logs:      mpg daemon logs`);
}

export function daemonUninstall(profile?: string): void {
  const name = unitFileName(profile);
  const servicePath = resolveServicePath(profile);

  try {
    execFileSync('systemctl', ['--user', 'stop', name], { stdio: 'inherit' });
  } catch {
    // May not be running
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', name], { stdio: 'inherit' });
  } catch {
    // May not be enabled
  }

  if (existsSync(servicePath)) {
    unlinkSync(servicePath);
  }

  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  } catch {
    // Best effort
  }

  console.log(`Uninstalled ${name}`);
}

export function daemonStatus(profile?: string): void {
  const name = unitFileName(profile);
  try {
    execFileSync('systemctl', ['--user', 'status', name], { stdio: 'inherit' });
  } catch {
    // systemctl status exits non-zero when service is stopped — that's OK
  }
}

export function daemonLogs(profile?: string, follow?: boolean): void {
  const name = unitFileName(profile);
  const args = ['--user', '-u', name, '--no-pager'];
  if (follow) args.push('-f');
  try {
    execFileSync('journalctl', args, { stdio: 'inherit' });
  } catch {
    console.error('journalctl not available. Use `mpg daemon logs --follow` with file-based logging.');
  }
}

function resolveOwnBinary(): string {
  // Try to find the mpg binary path
  try {
    const which = execSync('which mpg', { encoding: 'utf-8' }).trim();
    if (which) return which;
  } catch {
    // Fall through
  }

  // Fallback: use node + script path
  return resolve(process.argv[1] ?? '.');
}
