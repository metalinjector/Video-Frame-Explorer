/* ============================================================
   Minimal ZIP writer (STORE / no compression).
   Self-contained — no external dependencies, works offline.
   PNG/JPEG data is already compressed, so STORE keeps it fast
   and avoids shipping a DEFLATE implementation.

   Usage:
     const zip = new VFEZip();
     zip.add("frame_001.png", uint8array);
     const blob = await zip.generate();   // -> Blob (application/zip)
   ============================================================ */
(function (global) {
  "use strict";

  // --- CRC32 (precomputed table) ---
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // DOS date/time for the current moment
  function dosDateTime(d) {
    const time =
      ((d.getHours() & 0x1f) << 11) |
      ((d.getMinutes() & 0x3f) << 5) |
      ((Math.floor(d.getSeconds() / 2)) & 0x1f);
    const date =
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      (((d.getMonth() + 1) & 0x0f) << 5) |
      (d.getDate() & 0x1f);
    return { time, date };
  }

  function strToBytes(str) {
    // UTF-8 encode (file names may contain non-ASCII)
    return new TextEncoder().encode(str);
  }

  function VFEZip() {
    this.files = [];
  }

  VFEZip.prototype.add = function (name, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.files.push({ name: name, data: bytes });
  };

  VFEZip.prototype.generate = async function () {
    const now = new Date();
    const { time, date } = dosDateTime(now);
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of this.files) {
      const nameBytes = strToBytes(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      // Local file header (30 bytes + name)
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // signature
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // flags: UTF-8 names
      lv.setUint16(8, 0, true);            // method: STORE
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);        // compressed size
      lv.setUint32(22, size, true);        // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra length
      local.set(nameBytes, 30);

      chunks.push(local, f.data);

      // Central directory record (46 bytes + name)
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0x0800, true);       // flags: UTF-8
      cv.setUint16(10, 0, true);           // method
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra
      cv.setUint16(32, 0, true);           // comment
      cv.setUint16(34, 0, true);           // disk number
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, offset, true);      // local header offset
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + size;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const cd of central) { chunks.push(cd); centralSize += cd.length; }

    // End of central directory (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, this.files.length, true);
    ev.setUint16(10, this.files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);
    chunks.push(eocd);

    return new Blob(chunks, { type: "application/zip" });
  };

  global.VFEZip = VFEZip;
})(window);
