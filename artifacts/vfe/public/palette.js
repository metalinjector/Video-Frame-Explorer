/* ============================================================
   Palette analysis + Markdown generation
   - analyzePalette(imageData, maxColors) -> [{hex, rgb, count, percent}]
   - frameMarkdown(frame, palette) -> string (single frame)
   - combinedMarkdown(items) -> string (multiple frames)
   ============================================================ */
(function (global) {
  "use strict";

  function toHex(n) { return n.toString(16).padStart(2, "0"); }
  function rgbToHex(r, g, b) { return "#" + toHex(r) + toHex(g) + toHex(b); }

  /**
   * Quantize colours into 4-bit-per-channel buckets, accumulate true
   * averages per bucket, then return the most frequent ones.
   */
  function analyzePalette(imageData, maxColors) {
    maxColors = maxColors || 20;
    const data = imageData.data;
    const buckets = new Map();

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 16) continue; // skip near-transparent pixels
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // 4 bits per channel -> 4096 possible buckets
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let e = buckets.get(key);
      if (!e) { e = { r: 0, g: 0, b: 0, count: 0 }; buckets.set(key, e); }
      e.r += r; e.g += g; e.b += b; e.count++;
    }

    let total = 0;
    const list = [];
    buckets.forEach((e) => {
      total += e.count;
      list.push(e);
    });
    if (total === 0) return [];

    list.sort((a, b) => b.count - a.count);

    return list.slice(0, maxColors).map((e) => {
      const r = Math.round(e.r / e.count);
      const g = Math.round(e.g / e.count);
      const b = Math.round(e.b / e.count);
      return {
        hex: rgbToHex(r, g, b),
        rgb: [r, g, b],
        count: e.count,
        percent: +((e.count / total) * 100).toFixed(2),
      };
    });
  }

  function cssVarName(hex) {
    return "--color-" + hex.slice(1).toLowerCase();
  }

  /*
   * FIX: убран дублирующийся HEX-код в колонке «Превью».
   * Было: | `#xxxxxx` ![preview] | `#xxxxxx` | ...
   * Стало: | ![preview] | `#xxxxxx` | ...
   */
  function paletteTable(palette) {
    let md = "| # | Превью | HEX | RGB | Доля |\n|---|--------|-----|-----|------|\n";
    palette.forEach((c, i) => {
      const sw = "![](https://singlecolorimage.com/get/" + c.hex.slice(1) + "/24x24)";
      md += `| ${i + 1} | ${sw} | \`${c.hex}\` | \`rgb(${c.rgb.join(", ")})\` | ${c.percent}% |\n`;
    });
    return md;
  }

  function cssBlock(palette) {
    let css = ":root {\n";
    palette.forEach((c) => { css += `  ${cssVarName(c.hex)}: ${c.hex}; /* ${c.percent}% */\n`; });
    css += "}";
    return css;
  }

  function jsonBlock(frame, palette) {
    return JSON.stringify(
      {
        time: frame.time,
        timecode: frame.timecode,
        colors: palette.map((c) => ({
          hex: c.hex,
          rgb: c.rgb,
          percent: c.percent,
          css: cssVarName(c.hex),
        })),
      },
      null,
      2
    );
  }

  function frameMarkdown(frame, palette) {
    let md = "";
    md += `# Цветовая палитра кадра\n\n`;
    md += `- **Временная метка:** \`${frame.timecode}\` (${frame.time.toFixed(2)} с)\n`;
    md += `- **Кадр:** ${frame.label || "—"}\n`;
    md += `- **Количество цветов:** ${palette.length}\n\n`;
    md += `## Таблица цветов\n\n${paletteTable(palette)}\n`;
    md += `## CSS-переменные\n\n\`\`\`css\n${cssBlock(palette)}\n\`\`\`\n\n`;
    md += `## JSON\n\n\`\`\`json\n${jsonBlock(frame, palette)}\n\`\`\`\n`;
    return md;
  }

  function combinedMarkdown(items) {
    // items: [{ frame, palette }]
    let md = `# Цветовые палитры кадров\n\n`;
    md += `> Экспортировано: ${new Date().toLocaleString("ru-RU")}\n`;
    md += `> Всего кадров: **${items.length}**\n\n`;
    md += `## Содержание\n\n`;
    items.forEach((it, i) => {
      md += `${i + 1}. [Кадр ${i + 1} — ${it.frame.timecode}](#кадр-${i + 1})\n`;
    });
    md += `\n---\n\n`;

    items.forEach((it, i) => {
      const { frame, palette } = it;
      md += `## Кадр ${i + 1}\n\n`;
      md += `- **Номер:** ${i + 1} из ${items.length}\n`;
      md += `- **Временная метка:** \`${frame.timecode}\` (${frame.time.toFixed(2)} с)\n`;
      md += `- **Доминирующий цвет:** \`${palette[0] ? palette[0].hex : "—"}\`\n\n`;
      md += `### Таблица цветов\n\n${paletteTable(palette)}\n`;
      md += `### CSS-переменные\n\n\`\`\`css\n${cssBlock(palette)}\n\`\`\`\n\n`;
      md += `### JSON\n\n\`\`\`json\n${jsonBlock(frame, palette)}\n\`\`\`\n\n`;
      md += `---\n\n`;
    });

    return md;
  }

  global.VFEPalette = { analyzePalette, frameMarkdown, combinedMarkdown, rgbToHex };
})(window);
