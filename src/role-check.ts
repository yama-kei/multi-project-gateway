/**
 * Discord role-based access control.
 * Checks if a guild member has any of the allowed roles (by name or ID).
 */

import type { GuildMember } from 'discord.js';

/**
 * Returns true if the member is authorized, i.e. they have at least one of the allowedRoles.
 * If allowedRoles is empty or undefined, everyone is authorized (backward compatible).
 */
export function hasAllowedRole(member: GuildMember | null, allowedRoles: string[] | undefined): boolean {
  if (!allowedRoles || allowedRoles.length === 0) return true;
  if (!member) return false;

  return member.roles.cache.some(
    (role) => allowedRoles.includes(role.name) || allowedRoles.includes(role.id),
  );
}
