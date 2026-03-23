import type { GatewayConfig, ProjectConfig } from './config.js';

export interface ResolvedProject {
  channelId: string;
  name: string;
  directory: string;
}

export interface Router {
  resolve(channelId: string, parentChannelId?: string): ResolvedProject | null;
}

export function createRouter(config: GatewayConfig): Router {
  return {
    resolve(channelId: string, parentChannelId?: string): ResolvedProject | null {
      const project = config.projects[channelId];
      if (project) {
        return { channelId, name: project.name, directory: project.directory };
      }

      if (parentChannelId) {
        const parentProject = config.projects[parentChannelId];
        if (parentProject) {
          return { channelId, name: parentProject.name, directory: parentProject.directory };
        }
      }

      return null;
    },
  };
}
