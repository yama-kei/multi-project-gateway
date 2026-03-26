import { describe, it, expect } from 'vitest';
import { hasAllowedRole } from '../src/role-check.js';
import type { GuildMember, Collection, Role } from 'discord.js';

function mockMember(roles: { id: string; name: string }[]): GuildMember {
  const cache = new Map(roles.map((r) => [r.id, r]));
  return {
    roles: {
      cache: {
        some: (fn: (role: Role) => boolean) => roles.some((r) => fn(r as unknown as Role)),
      },
    },
  } as unknown as GuildMember;
}

describe('hasAllowedRole', () => {
  it('returns true when allowedRoles is undefined', () => {
    expect(hasAllowedRole(null, undefined)).toBe(true);
  });

  it('returns true when allowedRoles is empty', () => {
    expect(hasAllowedRole(null, [])).toBe(true);
  });

  it('returns false when member is null and roles are required', () => {
    expect(hasAllowedRole(null, ['admin'])).toBe(false);
  });

  it('returns true when member has a matching role by name', () => {
    const member = mockMember([{ id: '111', name: 'admin' }]);
    expect(hasAllowedRole(member, ['admin'])).toBe(true);
  });

  it('returns true when member has a matching role by ID', () => {
    const member = mockMember([{ id: '111', name: 'admin' }]);
    expect(hasAllowedRole(member, ['111'])).toBe(true);
  });

  it('returns false when member has no matching roles', () => {
    const member = mockMember([{ id: '111', name: 'member' }]);
    expect(hasAllowedRole(member, ['admin', 'moderator'])).toBe(false);
  });

  it('returns true when member has one of several allowed roles', () => {
    const member = mockMember([
      { id: '111', name: 'member' },
      { id: '222', name: 'developer' },
    ]);
    expect(hasAllowedRole(member, ['admin', 'developer'])).toBe(true);
  });
});
