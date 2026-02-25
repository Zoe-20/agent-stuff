#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  CONFIG_DIR,
  DEFAULT_VERSIONS,
  authorize,
  formatScopes,
  getGoogleApis,
} = require('./common');

function printHelp() {
  console.log(`Google Workspace API helper

Usage:
  node scripts/workspace.js call <service> <method.path> [params-json] [--version vX] [--scopes s1,s2]
  node scripts/workspace.js calendar-today [calendarId]
  node scripts/workspace.js drive-search <query>
  node scripts/workspace.js gmail-search <query>
  node scripts/workspace.js drive-upload <file-path> [--name <name>] [--parent <folderId>] [--share private|anyone]
  node scripts/workspace.js drive-pi-folder

Examples:
  node scripts/workspace.js call drive files.list '{"pageSize":5,"fields":"files(id,name)"}'
  node scripts/workspace.js call calendar events.list '{"calendarId":"primary","maxResults":10,"singleEvents":true,"orderBy":"startTime"}'
  node scripts/workspace.js drive-search "name contains 'Roadmap' and trashed=false"
  node scripts/workspace.js gmail-search "from:alice@example.com newer_than:7d"
  node scripts/workspace.js drive-pi-folder
  node scripts/workspace.js drive-upload ./plot.png
`);
}

function parseOptions(argv) {
  const positional = [];
  const options = {
    version: undefined,
    scopes: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      options.version = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--scopes') {
      options.scopes = formatScopes(argv[i + 1]);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  return { positional, options };
}

function resolveMethod(root, methodPath) {
  const parts = methodPath.split('.').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('method.path is empty');
  }

  let parent = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    parent = parent?.[parts[i]];
    if (!parent) {
      throw new Error(`Invalid method path (missing segment: ${parts[i]})`);
    }
  }

  const methodName = parts[parts.length - 1];
  const method = parent?.[methodName];

  if (typeof method !== 'function') {
    throw new Error(
      `Invalid method path: ${methodPath}. Final segment is not callable.`,
    );
  }

  return { parent, method };
}

function parseJsonObject(raw, label) {
  if (!raw) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return parsed;
}

async function callApi({ service, methodPath, params, version, scopes }) {
  const google = getGoogleApis();
  const factory = google[service];
  if (typeof factory !== 'function') {
    throw new Error(`Unknown Google API service: ${service}`);
  }

  const auth = await authorize({
    interactive: true,
    scopes: scopes && scopes.length > 0 ? scopes : undefined,
  });

  const api = factory({
    version: version || DEFAULT_VERSIONS[service] || 'v1',
    auth,
  });

  const { parent, method } = resolveMethod(api, methodPath);
  const response = await method.call(parent, params);
  return response?.data ?? response;
}

async function cmdCall(args, options) {
  const [service, methodPath, paramsRaw] = args;

  if (!service || !methodPath) {
    throw new Error('Usage: call <service> <method.path> [params-json]');
  }

  const params = parseJsonObject(paramsRaw, 'params-json');
  const data = await callApi({
    service,
    methodPath,
    params,
    version: options.version,
    scopes: options.scopes,
  });

  console.log(JSON.stringify(data, null, 2));
}

async function cmdCalendarToday(args, options) {
  const calendarId = args[0] || 'primary';

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const data = await callApi({
    service: 'calendar',
    methodPath: 'events.list',
    version: options.version,
    scopes: options.scopes,
    params: {
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    },
  });

  console.log(JSON.stringify(data, null, 2));
}

async function cmdDriveSearch(args, options) {
  const query = args.join(' ').trim();
  if (!query) {
    throw new Error('Usage: drive-search <query>');
  }

  const data = await callApi({
    service: 'drive',
    methodPath: 'files.list',
    version: options.version,
    scopes: options.scopes,
    params: {
      q: query,
      pageSize: 20,
      fields:
        'nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink)',
    },
  });

  console.log(JSON.stringify(data, null, 2));
}

function parseFlagArgs(rawArgs) {
  const args = [...rawArgs];
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--name' || arg === '--parent' || arg === '--share') {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      flags[arg.slice(2)] = value;
      i += 1;
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags };
}

const PI_FOLDER_NAME = 'pi-uploads';
const PI_FOLDER_CACHE_PATH = path.join(CONFIG_DIR, 'pi-folder.json');

function loadPiFolderCache() {
  try {
    if (!fs.existsSync(PI_FOLDER_CACHE_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(PI_FOLDER_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (typeof parsed.folderId !== 'string' || parsed.folderId.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function savePiFolderCache(payload) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PI_FOLDER_CACHE_PATH, JSON.stringify(payload, null, 2));
}

async function ensurePiFolder(drive) {
  const cached = loadPiFolderCache();

  if (cached?.folderId) {
    try {
      const res = await drive.files.get({
        supportsAllDrives: true,
        fileId: cached.folderId,
        fields: 'id,name,mimeType,trashed,webViewLink',
      });
      const folder = res.data;
      if (
        folder &&
        folder.id &&
        folder.trashed !== true &&
        folder.mimeType === 'application/vnd.google-apps.folder'
      ) {
        return folder;
      }
    } catch {
      // ignore and fall back to search/create
    }
  }

  const listRes = await drive.files.list({
    supportsAllDrives: true,
    q: `mimeType='application/vnd.google-apps.folder' and name='${PI_FOLDER_NAME}' and trashed=false`,
    pageSize: 10,
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime)',
  });

  const found = (listRes.data.files || [])[0];
  if (found?.id) {
    savePiFolderCache({ folderId: found.id, name: found.name });
    return found;
  }

  const createRes = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: PI_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id,name,mimeType,webViewLink',
  });

  const created = createRes.data;
  if (created?.id) {
    savePiFolderCache({ folderId: created.id, name: created.name });
  }
  return created;
}

async function cmdDrivePiFolder(args, options) {
  const google = getGoogleApis();
  const auth = await authorize({
    interactive: true,
    scopes: options.scopes && options.scopes.length > 0 ? options.scopes : undefined,
  });

  const drive = google.drive({
    version: options.version || DEFAULT_VERSIONS.drive || 'v3',
    auth,
  });

  const folder = await ensurePiFolder(drive);
  console.log(JSON.stringify(folder, null, 2));
}

async function cmdDriveUpload(args, options) {
  const { positional, flags } = parseFlagArgs(args);
  const filePath = positional[0];

  if (!filePath) {
    throw new Error(
      'Usage: drive-upload <file-path> [--name <name>] [--parent <folderId>] [--share private|anyone]',
    );
  }

  const absPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${absPath}`);
  }

  const google = getGoogleApis();

  const auth = await authorize({
    interactive: true,
    scopes: options.scopes && options.scopes.length > 0 ? options.scopes : undefined,
  });

  const drive = google.drive({
    version: options.version || DEFAULT_VERSIONS.drive || 'v3',
    auth,
  });

  const name = flags.name || path.basename(absPath);
  let parentId = flags.parent;
  const share = (flags.share || 'private').toLowerCase();

  if (!parentId) {
    const folder = await ensurePiFolder(drive);
    if (!folder?.id) {
      throw new Error('Failed to resolve or create pi upload folder on Drive.');
    }
    parentId = folder.id;
  }

  if (share !== 'anyone' && share !== 'private') {
    throw new Error("--share must be 'anyone' or 'private'");
  }

  const createRes = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name,
      parents: parentId ? [parentId] : undefined,
    },
    media: {
      mimeType: 'application/octet-stream',
      body: fs.createReadStream(absPath),
    },
    fields: 'id,name,mimeType,webViewLink,webContentLink,parents',
  });

  const created = createRes.data;

  if (share === 'anyone') {
    await drive.permissions.create({
      supportsAllDrives: true,
      fileId: created.id,
      requestBody: {
        type: 'anyone',
        role: 'reader',
      },
    });
  }

  const full = await drive.files.get({
    supportsAllDrives: true,
    fileId: created.id,
    fields: 'id,name,mimeType,webViewLink,webContentLink,parents,modifiedTime,size',
  });

  console.log(JSON.stringify(full.data, null, 2));
}

async function cmdGmailSearch(args, options) {
  const query = args.join(' ').trim();
  if (!query) {
    throw new Error('Usage: gmail-search <query>');
  }

  const list = await callApi({
    service: 'gmail',
    methodPath: 'users.messages.list',
    version: options.version,
    scopes: options.scopes,
    params: {
      userId: 'me',
      q: query,
      maxResults: 20,
    },
  });

  const messages = list.messages || [];
  const details = [];

  for (const message of messages.slice(0, 10)) {
    const full = await callApi({
      service: 'gmail',
      methodPath: 'users.messages.get',
      version: options.version,
      scopes: options.scopes,
      params: {
        userId: 'me',
        id: message.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      },
    });

    details.push({
      id: message.id,
      threadId: message.threadId,
      snippet: full.snippet,
      payload: full.payload,
    });
  }

  console.log(
    JSON.stringify(
      {
        resultCount: messages.length,
        messages: details,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const { positional, options } = parseOptions(process.argv.slice(2));
  const [command, ...args] = positional;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'call') {
    await cmdCall(args, options);
    return;
  }

  if (command === 'calendar-today') {
    await cmdCalendarToday(args, options);
    return;
  }

  if (command === 'drive-search') {
    await cmdDriveSearch(args, options);
    return;
  }

  if (command === 'drive-upload') {
    await cmdDriveUpload(args, options);
    return;
  }

  if (command === 'drive-pi-folder') {
    await cmdDrivePiFolder(args, options);
    return;
  }

  if (command === 'gmail-search') {
    await cmdGmailSearch(args, options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`❌ ${error?.message || String(error)}`);

  // Helpful debug info for Google API failures (avoid printing tokens).
  const status = error?.response?.status;
  const data = error?.response?.data;
  if (status) {
    console.error(`HTTP status: ${status}`);
  }
  if (data) {
    try {
      console.error('Response data:');
      console.error(JSON.stringify(data, null, 2));
    } catch {
      console.error('Response data (raw):');
      console.error(String(data));
    }
  }

  process.exit(1);
});
