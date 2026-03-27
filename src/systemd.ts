import { dirname } from 'node:path';

export function unitFileName(profile?: string): string {
  if (!profile || profile === 'default') return 'mpg.service';
  return `mpg-${profile}.service`;
}

export interface UnitFileOptions {
  nodePath: string;
  mpgPath: string;
  profile?: string;
}

export function generateUnitFile(opts: UnitFileOptions): string {
  const profileArg = opts.profile && opts.profile !== 'default'
    ? ` --profile ${opts.profile}`
    : '';

  const nodeDir = dirname(opts.nodePath);
  const mpgDir = dirname(opts.mpgPath);
  const pathDirs = new Set([nodeDir, mpgDir, '/usr/local/bin', '/usr/bin', '/bin']);
  const pathValue = [...pathDirs].join(':');

  return `[Unit]
Description=Multi-Project Gateway for Claude Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${opts.mpgPath} start${profileArg}
Restart=on-failure
RestartSec=10
Environment=PATH=${pathValue}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}
