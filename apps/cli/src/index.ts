import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  createLoginApp,
  DEFAULT_LOGIN_PORT,
  DEFAULT_MCP_PORT,
  DigitalPostError,
  EboksDeviceStore,
  generateEboksDevice,
  LoginRequiredError,
  loadOrCreateDeviceId,
  login,
  loopbackHost,
  pathsFromEnv,
  readAccountStatus,
  registerEboksDevice,
  runDoctor,
  Session,
  startRenewLoop,
  TokenStore,
} from '@digitalpost/client';
import { DigitalPostContext, startHttpServer, startStdioServer } from '@digitalpost/mcp-server';
import { serve } from 'bun';

const command = process.argv[2] ?? 'help';

try {
  switch (command) {
    case 'login':
      await runLogin();
      break;
    case 'whoami':
      await runWhoami();
      break;
    case 'renew':
      await runRenew(process.argv.includes('--force'));
      break;
    case 'status':
      await runStatus();
      break;
    case 'eboks-register':
      await runEboksRegister(process.argv.includes('--force'));
      break;
    case 'doctor':
      await runDoctorCommand(process.argv.includes('--probe-login'));
      break;
    case 'mcp':
      await runMcp(process.argv.includes('stdio'), process.argv.includes('--with-renew'));
      break;
    case 'serve':
      await runMcp(false, process.argv.includes('--with-renew'));
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Command failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof LoginRequiredError ? 2 : 1;
}

function printHelp(): void {
  process.stdout.write(`digitalpost — read-only Digital Post (offentlig post)

  login                 Open the local MitID login page (127.0.0.1:${DEFAULT_LOGIN_PORT})
  whoami                Login status and mailboxes. No letter contents.
  status                Login, token expiry, last renew, mailboxes. No secrets.
  renew                 Refresh the access token. Suitable for cron.
  renew --force         Retry a kept refresh token after login_required.
  eboks-register        Register this machine for private e-Boks (asks for the mobile-access password once).
  doctor                Check config, bind address, and the read-only guard.
  doctor --probe-login  Also walk the real authorize URL until MitID, then stop.
  mcp                   Streamable HTTP MCP on 127.0.0.1:${DEFAULT_MCP_PORT}
  mcp --with-renew      Same server, and refresh the token in this process
  serve --with-renew    Same as mcp --with-renew. See scripts/serve-with-renew.sh
  mcp stdio             MCP on stdin/stdout

Tokens stay in DIGITALPOST_DIR (default ~/.config/digitalpost-mcp), encrypted.
`);
}

async function openStore(): Promise<{ store: TokenStore; session: Session }> {
  const paths = pathsFromEnv();
  const store = new TokenStore({ paths });
  return { store, session: new Session({ store }) };
}

async function runWhoami(): Promise<void> {
  const { session } = await openStore();
  const stored = await session.status();
  if (stored?.status !== 'ok' || !stored?.tokens) {
    process.stdout.write(
      `${JSON.stringify(
        {
          loggedIn: false,
          status: stored?.status ?? 'anonymous',
          username: stored?.username ?? null,
        },
        null,
        2,
      )}\n`,
    );
    throw new LoginRequiredError();
  }
  const context = new DigitalPostContext();
  const mailboxes = await context.mailboxes();
  process.stdout.write(
    `${JSON.stringify(
      {
        loggedIn: true,
        status: 'ok',
        username: stored.username,
        accessExpiresAt: new Date(stored.tokens.expiresAt).toISOString(),
        lastRenewAt: new Date(stored.lastRenewAt ?? stored.savedAt).toISOString(),
        mailboxes,
      },
      null,
      2,
    )}\n`,
  );
}

async function runRenew(force = false): Promise<void> {
  const { session } = await openStore();
  const renewed = await session.renew(force ? { force: true } : {});
  process.stdout.write(
    `${JSON.stringify({ ok: true, accessExpiresAt: new Date(renewed.expiresAt).toISOString() }, null, 2)}\n`,
  );
}

async function runEboksRegister(force: boolean): Promise<void> {
  const paths = pathsFromEnv();
  const store = new EboksDeviceStore(paths);
  const existing = await store.load();
  if (existing?.activated && !force) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, alreadyRegistered: true, name: existing.name }, null, 2)}\n`,
    );
    return;
  }
  const password = (await readSecret('Mobiladgangskode: ')).trim();
  if (!password) throw new DigitalPostError('No mobile-access password was entered.');
  const { session } = await openStore();
  const device = existing ?? generateEboksDevice();
  const stored = await registerEboksDevice({
    digitalPostAccessToken: await session.accessToken(),
    password,
    device,
    paths,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, name: stored.name }, null, 2)}\n`);
}

async function readSecret(prompt: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return readPrompt(prompt);
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  let value = '';
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          output.write('\n');
          finish(new DigitalPostError('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          output.write('\n');
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char < ' ') continue;
        value += char;
      }
    };
    input.on('data', onData);
  });
}

async function readPrompt(prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function runStatus(): Promise<void> {
  const context = new DigitalPostContext();
  const device = await new EboksDeviceStore(context.paths).load().catch(() => null);
  const status = await readAccountStatus({
    session: context.session,
    listMailboxes: async () => {
      const stored = await context.session.status();
      if (stored?.status !== 'ok' || !stored.tokens) return [];
      return context.mailboxes();
    },
    eboksRegistered: Boolean(device?.activated),
  });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (!status.loggedIn) throw new LoginRequiredError();
}

async function runDoctorCommand(probe: boolean): Promise<void> {
  const paths = pathsFromEnv();
  const store = new TokenStore({ paths });
  const report = await runDoctor({ paths, store, probe });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runLogin(): Promise<void> {
  const paths = pathsFromEnv();
  const store = new TokenStore({ paths });
  const port = Number(process.env.DIGITALPOST_LOGIN_PORT ?? DEFAULT_LOGIN_PORT);
  const host = loopbackHost(process.env.DIGITALPOST_LOGIN_HOST);
  const deviceId = await loadOrCreateDeviceId(paths);
  const app = createLoginApp({
    status: async () => {
      const stored = await store.load();
      return {
        loggedIn: stored?.status === 'ok' && Boolean(stored.tokens?.refreshToken),
        username: stored?.username ?? null,
        status: stored?.status ?? 'anonymous',
      };
    },
    runLogin: async ({ username, signal, hooks }) => {
      const result = await login({ username, deviceId, hooks: { ...hooks, signal } });
      const savedAt = Date.now();
      await store.save({
        version: 1,
        status: 'ok',
        username: result.username,
        tokens: result.tokens,
        savedAt,
        lastRenewAt: savedAt,
      });
    },
  });
  serve({ hostname: host, port, fetch: app.fetch });
  process.stdout.write(`Login page: http://${host}:${port}/\n`);
  process.stdout.write('Approve the request in the MitID app, or scan the QR code on that page.\n');
  await new Promise(() => {
    // stays up until the process is stopped
  });
}

async function runMcp(stdio: boolean, withRenew: boolean): Promise<void> {
  if (stdio) {
    if (withRenew) {
      const { session } = await openStore();
      startRenewLoop(session);
    }
    await startStdioServer();
    return;
  }
  startHttpServer({ withRenew });
  await new Promise(() => {
    // stays up until the process is stopped
  });
}
