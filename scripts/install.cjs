'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync, execFile } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const HOST = 'com.vidrush.companion';

function extensionId(key) {
  return crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
}

async function response(url, headers = {}) {
  const result = await fetch(url, { headers: { 'User-Agent': 'VidRush-Installer/0.1', ...headers }, signal: AbortSignal.timeout(900000) });
  if (!result.ok) throw new Error(`Download failed (${result.status}): ${url}`);
  return result;
}

function checksumFor(text, filename) {
  const line = text.split(/\r?\n/).find(line => line.trim().split(/\s+/).at(-1)?.replace(/^\*/, '') === filename);
  const digest = line?.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(digest || '')) throw new Error(`No valid SHA-256 checksum found for ${filename}.`);
  return digest.toLowerCase();
}

async function downloadVerified(url, target, expected) {
  const cacheRoot = path.join(process.env.LOCALAPPDATA, 'VidRush', 'cache');
  const cache = path.join(cacheRoot, `${expected}-${path.basename(target)}`);
  async function verified(file) {
    if (!fs.existsSync(file)) return false;
    const hash = crypto.createHash('sha256');
    for await (const data of fs.createReadStream(file)) hash.update(data);
    return hash.digest('hex') === expected;
  }
  if (await verified(cache)) {
    fs.copyFileSync(cache, target);
    console.log(`Using verified cached ${path.basename(target)}.`);
    return;
  }
  console.log(`Downloading ${path.basename(target)} ...`);
  const result = await response(url);
  let received = 0, lastReported = 0;
  const meter = () => new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    if (received - lastReported >= 10 * 1024 * 1024) {
      console.log(`  ${Math.round(received / 1024 / 1024)} MB downloaded`);
      lastReported = received;
    }
    callback(null, chunk);
  } });
  const length = Number(result.headers.get('content-length'));
  if (length >= 8 * 1024 * 1024 && result.headers.get('accept-ranges') === 'bytes') {
    const downloadUrl = result.url;
    await result.body.cancel();
    const parts = Array.from({ length: 4 }, (_, index) => `${target}.part-${index}`);
    try {
      const downloads = await Promise.allSettled(parts.map(async (file, index) => {
        const start = Math.floor(length * index / parts.length);
        const end = Math.floor(length * (index + 1) / parts.length) - 1;
        // Windows' built-in curl handles long release-asset transfers reliably.
        // Keep a Node fallback for Windows images without curl.exe.
        try {
          await new Promise((resolve, reject) => execFile('curl.exe', ['--fail', '--location', '--silent', '--show-error',
            '--retry', '2', '--connect-timeout', '20', '--max-time', '900', '--range', `${start}-${end}`, '--output', file, downloadUrl],
          { windowsHide: true }, (error, _stdout, stderr) => error ? reject(Object.assign(error, { transferError: stderr })) : resolve()));
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error(`Release download failed: ${error.transferError || error.message}`);
          const part = await response(downloadUrl, { Range: `bytes=${start}-${end}` });
          if (part.status !== 206) { await part.body.cancel(); throw new Error('The download server did not honor a partial download request. Retry setup.'); }
          await pipeline(Readable.fromWeb(part.body), meter(), fs.createWriteStream(file));
        }
        if (fs.statSync(file).size !== end - start + 1) throw new Error('Incomplete release download. Retry setup.');
        console.log(`  Part ${index + 1}/${parts.length} downloaded.`);
      }));
      const failed = downloads.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      async function* chunks() { for (const part of parts) for await (const data of fs.createReadStream(part)) yield data; }
      await pipeline(Readable.from(chunks()), fs.createWriteStream(target));
    } finally { for (const part of parts) if (fs.existsSync(part)) fs.unlinkSync(part); }
  } else await pipeline(Readable.fromWeb(result.body), meter(), fs.createWriteStream(target));
  if (!await verified(target)) throw new Error(`Checksum verification failed: ${path.basename(target)}`);
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.copyFileSync(target, cache);
  console.log('SHA-256 verified.');
}

function findFile(directory, filename) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return target;
    if (entry.isDirectory()) { const found = findFile(target, filename); if (found) return found; }
  }
  return null;
}

async function install() {
  if (process.platform !== 'win32') throw new Error('This installer currently supports Windows only.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer, then retry.');
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error('Use 64-bit Windows with x64 or ARM64 Node.js.');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const id = extensionId(manifest.key);
  const destination = path.join(process.env.LOCALAPPDATA, 'VidRush');
  const bin = path.join(destination, 'bin');
  const runtime = path.join(destination, 'runtime');
  const host = path.join(destination, 'host');
  for (const directory of [bin, runtime, host]) fs.mkdirSync(directory, { recursive: true });
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'vidrush-install-'));
  try {
    const release = await (await response('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
    const ytFile = process.arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
    const ytAsset = release.assets.find(asset => asset.name === ytFile);
    const ytSums = release.assets.find(asset => asset.name === 'SHA2-256SUMS');
    if (!ytAsset || !ytSums) throw new Error('The yt-dlp release is missing the required Windows assets.');
    const checksums = await (await response(ytSums.browser_download_url)).text();
    await downloadVerified(ytAsset.browser_download_url, path.join(stage, 'yt-dlp.exe'), checksumFor(checksums, ytFile));

    const ffRelease = await (await response('https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest')).json();
    // Shared builds are substantially smaller downloads; install their DLLs too.
    const ffFile = `ffmpeg-master-latest-${process.arch === 'arm64' ? 'winarm64' : 'win64'}-gpl-shared.zip`;
    const ffAsset = ffRelease.assets.find(asset => asset.name === ffFile);
    const ffSums = ffRelease.assets.find(asset => asset.name === 'checksums.sha256');
    if (!ffAsset || !ffSums) throw new Error('The FFmpeg release is missing the required Windows assets.');
    const ffChecksums = await (await response(ffSums.browser_download_url)).text();
    const archive = path.join(stage, ffFile);
    await downloadVerified(ffAsset.browser_download_url, archive, checksumFor(ffChecksums, ffFile));
    console.log('Extracting FFmpeg (this can take a minute) ...');
    const extracted = path.join(stage, 'ffmpeg');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:VIDRUSH_ARCHIVE -DestinationPath $env:VIDRUSH_EXTRACTED'],
      { env: { ...process.env, VIDRUSH_ARCHIVE: archive, VIDRUSH_EXTRACTED: extracted }, windowsHide: true, stdio: 'inherit' });
    for (const filename of ['ffmpeg.exe', 'ffprobe.exe']) {
      const file = findFile(extracted, filename);
      if (!file) throw new Error(`${filename} was not found in the FFmpeg archive.`);
      fs.copyFileSync(file, path.join(bin, filename));
    }
    const ffBin = path.dirname(findFile(extracted, 'ffmpeg.exe'));
    for (const filename of fs.readdirSync(ffBin)) {
      if (filename.endsWith('.dll')) fs.copyFileSync(path.join(ffBin, filename), path.join(bin, filename));
    }
    fs.copyFileSync(path.join(stage, 'yt-dlp.exe'), path.join(bin, 'yt-dlp.exe'));
    fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
    for (const file of fs.readdirSync(path.join(root, 'host'))) {
      if (file.endsWith('.cjs')) fs.copyFileSync(path.join(root, 'host', file), path.join(host, file));
    }
    // Read the Windows Downloads known folder, including relocated/OneDrive folders.
    const downloads = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $v = Get-ItemPropertyValue -LiteralPath "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" -Name "{374DE290-123F-4565-9164-39C4925E467B}" -ErrorAction Stop; [Console]::Write([Environment]::ExpandEnvironmentVariables($v))'],
      { encoding: 'utf8', windowsHide: true }).replace(/^\uFEFF/, '').trim();
    const configPath = path.join(destination, 'config.json');
    let previous = {};
    if (fs.existsSync(configPath)) previous = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const config = {
      extensionId: id, ytdlpPath: path.join(bin, 'yt-dlp.exe'), ffmpegPath: bin,
      nodePath: path.join(runtime, 'node.exe'), downloadDir: previous.downloadDir || path.join(downloads, 'VidRush'),
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const launcher = path.join(destination, 'host.cmd');
    fs.writeFileSync(launcher, '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0host\\index.cjs" %*\r\n', 'ascii');
    const hostManifest = path.join(destination, `${HOST}.json`);
    fs.writeFileSync(hostManifest, `${JSON.stringify({ name: HOST, description: 'VidRush local yt-dlp companion', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }, null, 2)}\n`);
    execFileSync('reg.exe', ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`, '/ve', '/t', 'REG_SZ', '/d', hostManifest, '/f'], { windowsHide: true, stdio: 'pipe' });
    const version = execFileSync(config.ytdlpPath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync(path.join(bin, 'ffmpeg.exe'), ['-version'], { windowsHide: true, stdio: 'pipe' });
    console.log(`\nInstalled successfully. yt-dlp: ${version}\nExtension ID: ${id}\nVideos: ${config.downloadDir}`);
    console.log(`\nNext: open chrome://extensions, enable Developer mode, click Load unpacked, and select:\n${path.join(root, 'extension')}`);
    console.log('\nKeep this project folder in place while using the unpacked extension.');
  } finally {
    const relative = path.relative(os.tmpdir(), stage);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(stage).startsWith('vidrush-install-')) {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  }
}

if (require.main === module) install().catch(error => { console.error(`\nInstallation failed: ${error.message}\nClose Chrome before reinstalling. Check your connection, then retry.`); process.exitCode = 1; });
module.exports = { extensionId, checksumFor };
