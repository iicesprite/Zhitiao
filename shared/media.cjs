const imageLimit = 8 * 1024 * 1024;
const imageRequestLimit = Math.ceil((imageLimit + 28) * 4 / 3) + 16 * 1024;
const imageTypeMessage = '请选择 8 MB 以内的 PNG、JPG、GIF 或 WebP 图片。';

function imageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > imageLimit) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const signature = bytes.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

module.exports = { imageLimit, imageRequestLimit, imageType, imageTypeMessage };
