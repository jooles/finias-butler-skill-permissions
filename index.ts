/**
 * finias Skill Permissions Plugin
 *
 * Controls which users can install skills.
 * - Permission checking via tools (no standalone server needed)
 * - Admin UI routes should be registered through finias-management
 *
 * NOTE: This plugin NO LONGER runs its own web server.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// Use globalThis.registerFiniasRoute instead of import (set by management plugin)

// ===== Types =====
interface PluginConfig {
  port?: number;
  password?: string;
  defaultPolicy: 'allow' | 'deny';
  allowedUsers: string[];
  deniedUsers: string[];
  logInstallAttempts: boolean;
}

interface PluginAPI {
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  pluginConfig: PluginConfig;
}

interface InstallLog {
  timestamp: string;
  userId: string;
  skillName: string;
  allowed: boolean;
  reason: string;
}

// ===== Config =====
const CONFIG_FILE = join(dirname(import.meta.url.replace('file://', '')), 'permissions.json');
const LOG_DIR = join(homedir(), '.openclaw', 'logs');
const LOG_FILE = join(LOG_DIR, 'skill-permissions.log');

let config: PluginConfig;
let logger: PluginAPI['logger'] = {
  info: (msg: string) => console.log(`\x1b[36m${msg}\x1b[39m`),
  error: (msg: string) => console.error(`\x1b[31m${msg}\x1b[39m`)
};

function log(message: string) {
  logger.info(`[finias-skill-permissions] ${message}`);
}

function loadConfig(): PluginConfig {
  const defaultConfig: PluginConfig = {
    defaultPolicy: 'deny',
    allowedUsers: [],
    deniedUsers: [],
    logInstallAttempts: true
  };

  if (existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...defaultConfig, ...saved };
    } catch {
      return defaultConfig;
    }
  }
  return defaultConfig;
}

function saveConfig() {
  const toSave = {
    allowedUsers: config.allowedUsers,
    deniedUsers: config.deniedUsers,
    defaultPolicy: config.defaultPolicy,
    logInstallAttempts: config.logInstallAttempts
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2));
}

function logInstallAttempt(entry: InstallLog) {
  if (!config.logInstallAttempts) return;

  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    log(`Fehler beim Loggen: ${err}`);
  }
}

// ===== Permission Logic =====
export function canInstallSkill(userId: string): { allowed: boolean; reason: string } {
  // Normalize userId (remove channel prefixes if present)
  const normalizedId = userId.replace(/^(whatsapp:|telegram:|discord:)/, '');

  // Check denied list first (takes precedence)
  if (config.deniedUsers.some(u => normalizedId.includes(u) || u.includes(normalizedId))) {
    return { allowed: false, reason: 'Benutzer ist auf der Sperrliste' };
  }

  // Check allowed list
  if (config.allowedUsers.some(u => normalizedId.includes(u) || u.includes(normalizedId))) {
    return { allowed: true, reason: 'Benutzer ist auf der Whitelist' };
  }

  // Fall back to default policy
  if (config.defaultPolicy === 'allow') {
    return { allowed: true, reason: 'Standard-Richtlinie: Erlaubt' };
  }

  return { allowed: false, reason: 'Standard-Richtlinie: Verweigert (nur Whitelist-Benutzer)' };
}

// ===== Hook Handler =====
// Inject skill permission instruction into agent bootstrap
export const handler = async (event: { type: string; action: string; context?: { modelId: string; bootstrapFiles: Map<string, string>; sessionKey: string; agentId: string } }): Promise<void> => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') {
    return;
  }

  const ctx = event.context;
  if (!ctx?.bootstrapFiles) return;

  const instruction = `
## Skill Installation Permissions

BEVOR du einen Skill installierst (via \`clawdhub install\` oder ähnlich), MUSST du folgende Prüfung durchführen:

1. Nutze das Tool \`skill_permission_check\` mit der Benutzer-ID
2. WENN die Antwort \`"allowed": false\` enthält:
   - Installiere den Skill NICHT
   - Informiere den Benutzer höflich, dass er keine Berechtigung hat

Diese Regel ist VERBINDLICH für alle Skill-Installationen!
`;

  const existingClaude = ctx.bootstrapFiles.get('CLAUDE.md') || '';
  ctx.bootstrapFiles.set('CLAUDE.md', existingClaude + '\n' + instruction);

  log('Skill-Permission-Instruktion injiziert');
};

// ===== Plugin Registration =====
export default function register(api: PluginAPI) {
  logger = api.logger;
  log('===== PLUGIN LOADING =====');

  const pluginConfig = api.pluginConfig || {};

  // Merge saved config with plugin config (plugin config takes precedence)
  const savedConfig = loadConfig();
  config = {
    password: pluginConfig.password ?? savedConfig.password ?? '',
    defaultPolicy: pluginConfig.defaultPolicy ?? savedConfig.defaultPolicy ?? 'deny',
    allowedUsers: pluginConfig.allowedUsers ?? savedConfig.allowedUsers ?? [],
    deniedUsers: pluginConfig.deniedUsers ?? savedConfig.deniedUsers ?? [],
    logInstallAttempts: pluginConfig.logInstallAttempts ?? savedConfig.logInstallAttempts ?? true
  };

  log(`Standard-Richtlinie: ${config.defaultPolicy}`);
  log(`Erlaubte Benutzer: ${config.allowedUsers.length}`);
  log(`Gesperrte Benutzer: ${config.deniedUsers.length}`);
  log('NOTE: No standalone web server - admin UI via finias-management');

  // Register permission check tool
  api.registerTool({
    name: 'skill_permission_check',
    description: 'Prüfe ob ein Benutzer Skills installieren darf',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'ID des Benutzers (z.B. Telefonnummer, Telegram-ID)' },
        skillName: { type: 'string', description: 'Name des zu installierenden Skills' },
      },
      required: ['userId'],
    },
    execute: async (_id, params) => {
      const { userId, skillName = 'unknown' } = params as { userId: string; skillName?: string };
      const result = canInstallSkill(userId);

      // Log the attempt
      logInstallAttempt({
        timestamp: new Date().toISOString(),
        userId,
        skillName,
        allowed: result.allowed,
        reason: result.reason
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            userId,
            skill: skillName,
            allowed: result.allowed,
            reason: result.reason,
            message: result.allowed
              ? `Installation von "${skillName}" erlaubt.`
              : `Installation von "${skillName}" verweigert: ${result.reason}`
          }, null, 2)
        }]
      };
    },
  });

  // Register admin tools if configured
  if (config.allowedUsers.length > 0 || config.deniedUsers.length > 0 || config.defaultPolicy === 'deny') {
    api.registerTool({
      name: 'skill_permission_status',
      description: 'Zeigt die aktuellen Berechtigungseinstellungen',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              defaultPolicy: config.defaultPolicy,
              allowedUsers: config.allowedUsers,
              deniedUsers: config.deniedUsers,
              logInstallAttempts: config.logInstallAttempts,
            }, null, 2)
          }]
        };
      },
    });
  }

  log('===== PLUGIN READY =====');

  // Register routes with management plugin (with retry for load order issues)
  function tryRegisterRoutes(attempt = 1) {
    const registerFn = (globalThis as any).registerFiniasRoute;
    if (registerFn) {
      registerFn('finias-skill-permissions', [
        { method: 'GET', path: '/api/check', handler: async (req: any, res: any) => {
          const url = new URL(req.url || '/', 'http://localhost');
          const userId = url.searchParams.get('userId') || '';
          const skillName = url.searchParams.get('skill') || 'unknown';

          if (!userId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'userId parameter required' }));
            return;
          }

          const result = canInstallSkill(userId);
          logInstallAttempt({
            timestamp: new Date().toISOString(),
            userId,
            skillName,
            allowed: result.allowed,
            reason: result.reason
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            userId,
            skill: skillName,
            allowed: result.allowed,
            reason: result.reason,
            message: result.allowed
              ? `Installation von "${skillName}" erlaubt.`
              : `Installation von "${skillName}" verweigert: ${result.reason}`
          }));
        }},
        { method: 'GET', path: '/api/config', handler: async (req: any, res: any) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            defaultPolicy: config.defaultPolicy,
            allowedUsers: config.allowedUsers,
            deniedUsers: config.deniedUsers,
            logInstallAttempts: config.logInstallAttempts
          }));
        }},
        { method: 'GET', path: '/api/logs', handler: async (req: any, res: any) => {
          try {
            if (!existsSync(LOG_FILE)) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ logs: [] }));
              return;
            }
            const content = readFileSync(LOG_FILE, 'utf-8');
            const logs = content.trim().split('\n').filter(l => l.trim()).map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean).reverse().slice(0, 100);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ logs }));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read logs' }));
          }
        }},
      ]);
      log('Routes registered with management plugin');
    } else if (attempt < 10) {
      setTimeout(() => tryRegisterRoutes(attempt + 1), 100);
    } else {
      log('registerFiniasRoute not available after 10 attempts - routes not registered');
    }
  }
  tryRegisterRoutes();
}

// Cleanup - no server to close
process.on('SIGTERM', () => {
  // No cleanup needed
});

process.on('SIGINT', () => {
  // No cleanup needed
});
