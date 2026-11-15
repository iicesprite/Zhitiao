const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { win32 } = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const defaultPorts = { localPort: 8787, httpsPort: 443 };

function port(value, label) {
  const input = String(value ?? '');
  const number = Number(input);
  if (!/^\d{1,5}$/.test(input) || number < 1 || number > 65535) {
    throw new Error(label + '请输入 1 到 65535 的整数。');
  }
  return number;
}

function servePorts(fields = {}) {
  return {
    localPort: port(fields.localPort ?? defaultPorts.localPort, '纸条服务端口：'),
    httpsPort: port(fields.httpsPort ?? defaultPorts.httpsPort, 'HTTPS 入口端口：')
  };
}

function localAddress({ localPort }) {
  return 'http://127.0.0.1:' + localPort;
}

function serveArgs(fields, stop = false) {
  const ports = servePorts(fields);
  const args = ['serve', '--bg'];
  if (ports.httpsPort !== 443) args.push('--https=' + ports.httpsPort);
  args.push(localAddress(ports));
  if (stop) args.push('off');
  return args;
}

function installedTailscale() {
  // Only the vendor's installation directories can be used for the UAC fallback.
  const systemDrive = /^[a-z]:$/i.test(process.env.SystemDrive) ? process.env.SystemDrive : 'C:';
  return ['Program Files', 'Program Files (x86)']
    .map((dir) => win32.join(systemDrive + '\\', dir, 'Tailscale', 'tailscale.exe'))
    .find((binary) => existsSync(binary));
}

async function run(file, args) {
  const result = await exec(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return result.stdout;
}

async function elevated(file, args) {
  // All arguments come from serveArgs. The executable is limited to Program Files.
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const command = "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath " + quote(file)
    + ' -ArgumentList @(' + args.map(quote).join(',') + ')'
    + ' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode';
  const powershell = win32.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024
  });
}

function busyPort(config, httpsPort) {
  if (config.TCP?.[httpsPort]) return true;
  const suffix = ':' + httpsPort;
  return Object.keys(config.Web ?? {}).some((address) => address.endsWith(suffix))
    || Object.entries(config.AllowFunnel ?? {}).some(([address, active]) => active && address.endsWith(suffix));
}

function inspectRoute(config, hostname, ports) {
  const { httpsPort } = ports;
  const address = hostname + ':' + httpsPort;
  const proxy = config.Web?.[address]?.Handlers?.['/']?.Proxy;
  const foreground = Object.values(config.Foreground ?? {}).some((entry) => busyPort(entry, httpsPort));
  const funnel = Object.entries(config.AllowFunnel ?? {})
    .some(([key, active]) => active && key.endsWith(':' + httpsPort));
  if (!foreground && !funnel && config.TCP?.[httpsPort]?.HTTPS
      && (proxy === localAddress(ports) || proxy === localAddress(ports) + '/')) {
    const url = new URL('https://' + address).origin;
    return { state: 'active', url, message: '私有 HTTPS 已启动。' };
  }
  if (foreground || busyPort(config, httpsPort)) {
    return { state: 'occupied', message: '这个 HTTPS 端口已有其他 Tailscale 配置。请选择另一个端口。' };
  }
  return { state: 'ready', message: 'Tailscale 已连接，可以启动私有 HTTPS。' };
}

async function probePaper(ports, config) {
  const origin = localAddress(ports);
  const request = (suffix, headers) => fetch(origin + suffix, {
    headers, redirect: 'error', signal: AbortSignal.timeout(3000)
  });
  try {
    const health = await request('/health');
    if (!health.ok || (await health.json()).ok !== true) return null;
    const identity = await request('/api/state');
    if (identity.status !== 401 || (await identity.json()).error !== '配对凭据无效。') return null;
    if (!config) return { canInvite: false };
    const state = await request('/api/state', { Authorization: 'Bearer ' + config.token });
    const data = await state.json();
    return state.ok && data.me?.id === config.role ? { canInvite: !data.partner } : null;
  } catch {
    return null;
  }
}

async function checkHttps(url) {
  try {
    const response = await fetch(url + '/health', { redirect: 'error', signal: AbortSignal.timeout(3500) });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

function errorText(error) {
  return [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
}

function createTailscale({ find = installedTailscale, command = run, withAdmin = elevated,
  probe = probePaper, verifyHttps = checkHttps } = {}) {
  async function inspect(ports) {
    const file = find();
    if (!file) return { state: 'missing', message: '请先安装 Windows 版 Tailscale。' };
    let client;
    try {
      client = JSON.parse(await command(file, ['status', '--json']));
    } catch {
      return { state: 'disconnected', message: '无法连接到 Tailscale。请打开 Tailscale 并确认它在运行。' };
    }
    const hostname = client.Self?.DNSName?.replace(/\.$/, '').toLowerCase();
    if (client.BackendState !== 'Running' || !/^[a-z0-9][a-z0-9.-]*\.ts\.net$/.test(hostname ?? '')) {
      return { state: 'disconnected', message: '请先在 Windows 托盘打开 Tailscale，登录并连接。' };
    }
    try {
      const output = await command(file, ['serve', 'status', '--json']);
      const config = JSON.parse(output.trim() || '{}') ?? {};
      return { ...inspectRoute(config, hostname, ports), file };
    } catch {
      return { state: 'unavailable', message: '无法读取 Serve 配置。请检查 Tailscale 版本和当前账号权限。' };
    }
  }

  async function change(file, ports, stop) {
    const args = serveArgs(ports, stop);
    try {
      await command(file, args);
    } catch (error) {
      const output = errorText(error);
      if (/access (?:is )?denied|permission denied|administrator|拒绝访问|must be admin/i.test(output)) {
        await withAdmin(file, args).catch(() => {
          throw new Error('Windows 未能以管理员权限完成设置。请批准弹出的权限提示，并确认 Tailscale 已启用 HTTPS。');
        });
      } else if (error.killed || /enable.*https|https.*(disabled|provision|feature)|certificate/i.test(output)) {
        throw new Error('请在 Tailscale 的 DNS 设置里启用 HTTPS Certificates，再重试。');
      } else {
        throw new Error('Tailscale 未能应用 Serve 设置。请刷新状态后重试。');
      }
    }
  }

  async function update(action, fields, pairing) {
    const ports = servePorts(fields);
    let result = await inspect(ports);
    let local;
    if (action === 'start' && ['ready', 'active'].includes(result.state)) {
      local = await probe(ports, pairing);
      if (!local) {
        throw new Error('请确认 ' + localAddress(ports) + ' 上运行的是与你当前配对匹配的纸条服务。');
      }
      if (result.state === 'ready') {
        await change(result.file, ports, false);
        result = await inspect(ports);
        if (result.state !== 'active') throw new Error('Serve 尚未确认启动。请刷新状态，或检查 Tailscale 的 HTTPS 设置。');
      }
    }
    if (action === 'stop' && result.state === 'active') {
      await change(result.file, ports, true);
      result = await inspect(ports);
      if (result.state === 'active') throw new Error('Serve 仍在运行。请刷新状态后重试。');
    }
    if (result.url) {
      local ??= await probe(ports, pairing);
      if (!local) result.message = 'Serve 已启动。本地纸条服务未连通，或与当前配对不匹配。';
      else if (!await verifyHttps(result.url)) result.message = 'Serve 已配置。HTTPS 检查暂未通过，可稍后点「检查状态」。';
      else result.message = '私有 HTTPS 已连通。';
    }
    return { state: result.state, message: result.message, url: result.url,
      canInvite: Boolean(result.url && local?.canInvite), ports };
  }

  return { update };
}

module.exports = { createTailscale, servePorts, serveArgs };
