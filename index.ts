import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ===== Types =====
interface PluginConfig {
  port: number;
  password: string;
  defaultPolicy: 'allow' | 'deny';
  allowedUsers: string[];
  deniedUsers: string[];
  logInstallAttempts: boolean;
}

interface HookEvent {
  type: 'agent' | 'gateway' | 'command' | 'session';
  action: string;
  context?: AgentBootstrapContext;
}

interface AgentBootstrapContext {
  modelId: string;
  bootstrapFiles: Map<string, string>;
  sessionKey: string;
  agentId: string;
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
const LOG_DIR = join(homedir(), '.clawdbot', 'logs');
const LOG_FILE = join(LOG_DIR, 'skill-permissions.log');

let config: PluginConfig;
let server: ReturnType<typeof createServer> | null = null;

function log(message: string) {
  console.log(`\x1b[36m[finias-skill-permissions] ${message}\x1b[39m`);
}

function loadConfig(): PluginConfig {
  const defaultConfig: PluginConfig = {
    port: 18803,
    password: '',
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
function canInstallSkill(userId: string): { allowed: boolean; reason: string } {
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

// ===== HTTP Server =====
function sendJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost:${config.port}`);
  const path = url.pathname;
  const method = req.method || 'GET';
  const auth = url.searchParams.get('auth');

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // Auth check for admin endpoints
  const isAdmin = auth === config.password;

  // ===== Public API: Check Permission =====
  // This endpoint can be called by the agent to check if a user can install skills
  if (path === '/api/check' && method === 'GET') {
    const userId = url.searchParams.get('userId');
    const skillName = url.searchParams.get('skill') || 'unknown';

    if (!userId) {
      sendJson(res, { error: 'userId parameter required' }, 400);
      return;
    }

    const result = canInstallSkill(userId);

    // Log the attempt
    logInstallAttempt({
      timestamp: new Date().toISOString(),
      userId,
      skillName,
      allowed: result.allowed,
      reason: result.reason
    });

    sendJson(res, {
      userId,
      skill: skillName,
      allowed: result.allowed,
      reason: result.reason,
      message: result.allowed
        ? `Installation von "${skillName}" erlaubt.`
        : `Installation von "${skillName}" verweigert: ${result.reason}`
    });
    return;
  }

  // ===== Admin API: Get Config =====
  if (path === '/api/config' && method === 'GET') {
    if (!isAdmin) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    sendJson(res, {
      defaultPolicy: config.defaultPolicy,
      allowedUsers: config.allowedUsers,
      deniedUsers: config.deniedUsers,
      logInstallAttempts: config.logInstallAttempts
    });
    return;
  }

  // ===== Admin API: Update Config =====
  if (path === '/api/config' && method === 'PUT') {
    if (!isAdmin) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    parseBody(req).then(body => {
      try {
        const updates = JSON.parse(body);

        if (updates.defaultPolicy !== undefined) {
          config.defaultPolicy = updates.defaultPolicy;
        }
        if (updates.allowedUsers !== undefined) {
          config.allowedUsers = updates.allowedUsers;
        }
        if (updates.deniedUsers !== undefined) {
          config.deniedUsers = updates.deniedUsers;
        }
        if (updates.logInstallAttempts !== undefined) {
          config.logInstallAttempts = updates.logInstallAttempts;
        }

        saveConfig();
        sendJson(res, { success: true, config: {
          defaultPolicy: config.defaultPolicy,
          allowedUsers: config.allowedUsers,
          deniedUsers: config.deniedUsers,
          logInstallAttempts: config.logInstallAttempts
        }});
      } catch (err) {
        sendJson(res, { error: 'Invalid JSON' }, 400);
      }
    });
    return;
  }

  // ===== Admin API: Add User =====
  if (path === '/api/users/allow' && method === 'POST') {
    if (!isAdmin) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    parseBody(req).then(body => {
      try {
        const { userId } = JSON.parse(body);
        if (!userId) {
          sendJson(res, { error: 'userId required' }, 400);
          return;
        }

        // Remove from denied if present
        config.deniedUsers = config.deniedUsers.filter(u => u !== userId);

        // Add to allowed if not present
        if (!config.allowedUsers.includes(userId)) {
          config.allowedUsers.push(userId);
        }

        saveConfig();
        sendJson(res, { success: true, allowedUsers: config.allowedUsers });
      } catch {
        sendJson(res, { error: 'Invalid JSON' }, 400);
      }
    });
    return;
  }

  // ===== Admin API: Deny User =====
  if (path === '/api/users/deny' && method === 'POST') {
    if (!isAdmin) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    parseBody(req).then(body => {
      try {
        const { userId } = JSON.parse(body);
        if (!userId) {
          sendJson(res, { error: 'userId required' }, 400);
          return;
        }

        // Remove from allowed if present
        config.allowedUsers = config.allowedUsers.filter(u => u !== userId);

        // Add to denied if not present
        if (!config.deniedUsers.includes(userId)) {
          config.deniedUsers.push(userId);
        }

        saveConfig();
        sendJson(res, { success: true, deniedUsers: config.deniedUsers });
      } catch {
        sendJson(res, { error: 'Invalid JSON' }, 400);
      }
    });
    return;
  }

  // ===== Admin API: Remove User from lists =====
  if (path === '/api/users/remove' && method === 'POST') {
    if (!isAdmin) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    parseBody(req).then(body => {
      try {
        const { userId } = JSON.parse(body);
        if (!userId) {
          sendJson(res, { error: 'userId required' }, 400);
          return;
        }

        config.allowedUsers = config.allowedUsers.filter(u => u !== userId);
        config.deniedUsers = config.deniedUsers.filter(u => u !== userId);

        saveConfig();
        sendJson(res, {
          success: true,
          allowedUsers: config.allowedUsers,
          deniedUsers: config.deniedUsers
        });
      } catch {
        sendJson(res, { error: 'Invalid JSON' }, 400);
      }
    });
    return;
  }

  // ===== Admin API: Get Logs =====
  if (path === '/api/logs' && method === 'GET') {
    if (!isAdmin) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    try {
      if (!existsSync(LOG_FILE)) {
        sendJson(res, { logs: [] });
        return;
      }

      const content = readFileSync(LOG_FILE, 'utf-8');
      const logs = content.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean)
        .reverse()
        .slice(0, 100); // Last 100 entries

      sendJson(res, { logs });
    } catch (err) {
      sendJson(res, { error: 'Failed to read logs' }, 500);
    }
    return;
  }

  // 404
  sendJson(res, { error: 'Not found' }, 404);
}

// ===== Hook Handler =====
// Inject skill permission instruction into agent bootstrap
export const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') {
    return;
  }

  const ctx = event.context;
  if (!ctx?.bootstrapFiles) return;

  // Create the permission check instruction
  const instruction = `
## Skill Installation Permissions

BEVOR du einen Skill installierst (via \`clawdhub install\` oder ähnlich), MUSST du folgende Prüfung durchführen:

1. Rufe diesen API-Endpunkt auf:
   \`\`\`
   curl "http://localhost:${config.port}/api/check?userId={SENDER_ID}&skill={SKILL_NAME}"
   \`\`\`

2. Ersetze {SENDER_ID} mit der ID des anfragenden Benutzers (z.B. Telefonnummer, Telegram-ID)
3. Ersetze {SKILL_NAME} mit dem Namen des zu installierenden Skills

3. WENN die Antwort \`"allowed": false\` enthält:
   - Installiere den Skill NICHT
   - Informiere den Benutzer höflich, dass er keine Berechtigung hat
   - Zeige ihm den Grund aus der API-Antwort

4. NUR WENN \`"allowed": true\`: Fahre mit der Installation fort.

Diese Regel ist VERBINDLICH für alle Skill-Installationen!
`;

  // Append to existing CLAUDE.md or create directive
  const existingClaude = ctx.bootstrapFiles.get('CLAUDE.md') || '';
  ctx.bootstrapFiles.set('CLAUDE.md', existingClaude + '\n' + instruction);

  log('Skill-Permission-Instruktion injiziert');
};

// ===== Plugin Init =====
export default function init(pluginConfig: PluginConfig) {
  log('===== PLUGIN LOADING =====');

  config = { ...loadConfig(), ...pluginConfig };
  log(`Port: ${config.port}`);
  log(`Standard-Richtlinie: ${config.defaultPolicy}`);
  log(`Erlaubte Benutzer: ${config.allowedUsers.length}`);
  log(`Gesperrte Benutzer: ${config.deniedUsers.length}`);

  // Start HTTP server
  server = createServer(handleRequest);
  server.listen(config.port, '0.0.0.0', () => {
    log(`API läuft auf Port ${config.port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${config.port} bereits belegt - Plugin läuft möglicherweise schon`);
    } else {
      log(`Server-Fehler: ${err.message}`);
    }
  });

  log('===== PLUGIN READY =====');

  return {
    stop: () => {
      if (server) {
        server.close();
        server = null;
      }
    }
  };
}
