const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { open, readFile, realpath, stat } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const powershell = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$connections = @(Get-NetTCPConnection -State Listen | Where-Object {
  $_.LocalPort -eq [int]$env:ZHITIAO_CONTROL_PORT -and $_.LocalAddress -in @($env:ZHITIAO_CONTROL_HOST, '0.0.0.0', '::')
})
if ($connections.Count -eq 0) { Write-Output '{"idle":true}'; exit }
if ($connections.Count -ne 1 -or $connections[0].LocalAddress -ne $env:ZHITIAO_CONTROL_HOST) {
  Write-Output '{"foreign":true}'; exit
}
$ownerId = $connections[0].OwningProcess
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
$mySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$command = $process.CommandLine -replace '/', '\'
$entry = [regex]::Escape($env:ZHITIAO_CONTROL_ENTRY)
$pattern = '^(?:"[^"\r\n]+"|\S+)\s+"?(?:' + $entry + '|server\\http\.cjs)"?\s*$'
if ($process.Name -ne 'node.exe' -or $owner.Sid -ne $mySid -or $command -notmatch $pattern) {
  Write-Output '{"foreign":true}'; exit
}
$target = Get-Process -Id $ownerId
$started = $target.StartTime.ToUniversalTime().Ticks.ToString()
if ($env:ZHITIAO_CONTROL_PID) {
  if ($ownerId -ne [int]$env:ZHITIAO_CONTROL_PID -or $started -ne $env:ZHITIAO_CONTROL_STARTED) {
    Write-Output '{"changed":true}'; exit
  }
  Stop-Process -InputObject $target
  if (!$target.WaitForExit(5000)) { throw 'Backend did not exit' }
  Write-Output '{"stopped":true}'; exit
}
@{ pid = $ownerId; started = $started } | ConvertTo-Json -Compress
`;

const verify = `
require(process.env.ZHITIAO_CONTROL_ENTRY);
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.ZHITIAO_DB, { readOnly: true });
try {
  const devices = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'devices'").get();
  const sql = devices ? 'SELECT member AS id FROM devices WHERE token_hash = ? AND revoked_at IS NULL'
    : 'SELECT id FROM people WHERE token_hash = ?';
  if (db.prepare(sql).get(process.env.ZHITIAO_CONTROL_DIGEST)?.id !== Number(process.env.ZHITIAO_CONTROL_ROLE)) process.exitCode = 2;
} finally { db.close(); }
`;

async function sourceEntry(directory) {
  const root = await realpath(directory);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const entry = path.join(root, 'server', 'http.cjs');
  if (manifest.name !== 'zhitiao-pet' || !(await stat(entry)).isFile()) throw new Error('请选择纸条源码的项目目录。');
  return { root, entry, version: manifest.version };
}

async function windowsListener(host, port, entry, expected) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 12_000,
      env: { ...process.env, ZHITIAO_CONTROL_HOST: host, ZHITIAO_CONTROL_PORT: String(port), ZHITIAO_CONTROL_ENTRY: entry,
        ZHITIAO_CONTROL_PID: expected ? String(expected.pid) : '', ZHITIAO_CONTROL_STARTED: expected?.started ?? '' }
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error('无法读取或停止本机服务进程，请确认当前 Windows 用户可以管理它。');
  }
}

async function responds(url, config) {
  try {
    const response = await fetch(url + '/api/state', {
      headers: { Authorization: 'Bearer ' + config.token }, redirect: 'error', signal: AbortSignal.timeout(900)
    });
    return response.ok && (await response.json()).me?.id === config.role;
  } catch {
    return false;
  }
}

async function restartLocalServer({ directory, database, config, port, logFile }) {
  const configured = new URL(config.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname) || Number(configured.port || 80) !== port) {
    throw new Error('请在纸条服务所在的 Windows 电脑操作，并填写本机配对使用的服务端口。');
  }
  const ipv6 = configured.hostname === '[::1]';
  const host = ipv6 ? '::1' : '127.0.0.1';
  const url = 'http://' + (ipv6 ? '[::1]' : host) + ':' + port;
  const { root, entry, version } = await sourceEntry(directory).catch(() => { throw new Error('找不到纸条源码，请重新选择源码目录。'); });
  const db = await realpath(database || path.join(root, 'data', 'zhitiao.sqlite')).catch(() => {
    throw new Error('找不到原来的纸条数据库，请选择它的位置。');
  });
  const env = { ...process.env, HOST: host, PORT: String(port), ZHITIAO_DB: db };
  const options = { cwd: root, env, windowsHide: true, timeout: 8000 };
  try {
    await exec('node.exe', ['--check', entry], options);
    await exec('node.exe', ['-e', verify], { ...options, env: { ...env,
      ZHITIAO_CONTROL_ENTRY: entry, ZHITIAO_CONTROL_DIGEST: createHash('sha256').update(config.token).digest('hex'),
      ZHITIAO_CONTROL_ROLE: String(config.role) } });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到 Node.js，请安装 Node.js 24 并重开桌宠。');
    if (error.code === 2) throw new Error('选中的数据库和当前配对不匹配，请选择原数据库。');
    throw new Error('无法用本机 Node.js 检查源码和数据库，请确认已安装 Node.js 24 且源码可运行。');
  }

  const log = await open(logFile, 'a');
  let child;
  let exited = false;
  try {
    const running = await windowsListener(host, port, entry);
    if (!running.idle) {
      if (running.foreign || !running.pid || !await responds(url, config)) {
        throw new Error('该端口的进程或配对与当前配置不匹配，请核对服务端口和源码目录。');
      }
      const stopped = await windowsListener(host, port, entry, running);
      if (!stopped.stopped && !stopped.idle) throw new Error('端口上的进程已变化，请重试。');
    }
    child = spawn('node.exe', [entry], { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('exit', () => { exited = true; });
    await once(child, 'spawn');
    child.unref();
  } finally {
    await log.close();
  }
  for (let attempt = 0; attempt < 16 && !exited; attempt++) {
    if (await responds(url, config) && !exited) {
      const running = await windowsListener(host, port, entry);
      if (running.pid === child.pid) return { version, port };
      break;
    }
    await delay(300);
  }
  throw new Error('启动后未通过连接检查，服务日志在 ' + logFile);
}

module.exports = { sourceEntry, restartLocalServer };
