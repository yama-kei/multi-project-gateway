import { describe, it, expect } from 'vitest';
import { generateUnitFile, unitFileName } from '../src/systemd.js';

describe('unitFileName', () => {
  it('returns mpg.service for default profile', () => {
    expect(unitFileName()).toBe('mpg.service');
    expect(unitFileName('default')).toBe('mpg.service');
  });

  it('returns mpg-<profile>.service for named profile', () => {
    expect(unitFileName('work')).toBe('mpg-work.service');
  });
});

describe('generateUnitFile', () => {
  it('produces a valid systemd unit', () => {
    const unit = generateUnitFile({ nodePath: '/usr/bin/node', mpgPath: '/usr/local/bin/mpg' });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=10');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('uses the provided mpg path in ExecStart', () => {
    const unit = generateUnitFile({ nodePath: '/home/user/.nvm/node', mpgPath: '/home/user/.npm/bin/mpg' });
    expect(unit).toContain('ExecStart=/home/user/.npm/bin/mpg start');
  });

  it('includes profile flag for non-default profiles', () => {
    const unit = generateUnitFile({ nodePath: '/usr/bin/node', mpgPath: '/usr/local/bin/mpg', profile: 'work' });
    expect(unit).toContain('--profile work');
  });

  it('does not include profile flag for default profile', () => {
    const unit = generateUnitFile({ nodePath: '/usr/bin/node', mpgPath: '/usr/local/bin/mpg', profile: 'default' });
    expect(unit).not.toContain('--profile');
  });

  it('sets PATH in Environment', () => {
    const unit = generateUnitFile({ nodePath: '/home/user/.nvm/versions/20/bin/node', mpgPath: '/usr/local/bin/mpg' });
    expect(unit).toContain('Environment=PATH=');
    expect(unit).toContain('/home/user/.nvm/versions/20/bin');
  });
});
