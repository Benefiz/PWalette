export function argbToRgba(val) {
  if (!val) return 'transparent';
  // PixelWalker colors are stored as 32-bit ARGB values.
  // E.g. 4285427310. We extract each byte.
  let a = ((val >>> 24) & 0xFF) / 255;
  // If the value is a 24-bit RGB integer (no alpha component), default alpha to 1 (opaque)
  if (val <= 0xFFFFFF) {
    a = 1;
  }
  const r = (val >>> 16) & 0xFF;
  const g = (val >>> 8) & 0xFF;
  const b = val & 0xFF;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function pascalToSnake(str) {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

export function snakeToPascal(str) {
  return str.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

export function argbToHex(argb) {
  if (!argb) return '#000000';
  const r = ((argb >>> 16) & 0xFF).toString(16).padStart(2, '0');
  const g = ((argb >>> 8) & 0xFF).toString(16).padStart(2, '0');
  const b = (argb & 0xFF).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

export function hexToArgb(hex) {
  if (!hex || hex.charAt(0) !== '#') return 4278190080; // default black
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Alpha is solid (0xFF)
  return (255 * 16777216) + (r * 65536) + (g * 256) + b;
}
