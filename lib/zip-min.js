/* GIF Grabber — minimal ZIP writer (STORE method).
 * GIF files are already compressed, so no deflate is needed; this keeps the
 * packer tiny, dependency-free and fast. Produces a standard .zip Blob. */
(function (root) {
  'use strict';

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  function MiniZip() {
    this.parts = [];   // local chunks
    this.central = []; // central directory records
    this.offset = 0;
    this.count = 0;
  }

  MiniZip.prototype.add = function (name, data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const nameBytes = new TextEncoder().encode(String(name));
    const crc = crc32(u8);
    const dt = dosDateTime(new Date());

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);  // local file header signature
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // flags: UTF-8 names
    lv.setUint16(8, 0, true);           // method: store
    lv.setUint16(10, dt.time, true);
    lv.setUint16(12, dt.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, u8.length, true);  // compressed size
    lv.setUint32(22, u8.length, true);  // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // extra len
    local.set(nameBytes, 30);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);  // central directory signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);      // flags
    cv.setUint16(10, 0, true);          // method
    cv.setUint16(12, dt.time, true);
    cv.setUint16(14, dt.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, u8.length, true);
    cv.setUint32(24, u8.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(38, 0, true);          // external attrs
    cv.setUint32(42, this.offset, true); // local header offset
    cen.set(nameBytes, 46);

    this.parts.push(local, u8);
    this.central.push(cen);
    this.offset += local.length + u8.length;
    this.count++;
  };

  MiniZip.prototype.finish = function () {
    let cdSize = 0;
    for (const c of this.central) cdSize += c.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);  // end of central directory
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, this.offset, true);
    const all = this.parts.concat(this.central);
    all.push(end);
    return new Blob(all, { type: 'application/zip' });
  };

  root.MiniZip = MiniZip;
})(globalThis);
