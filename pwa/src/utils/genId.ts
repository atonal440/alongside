const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export function genId(prefix = 't'): string {
  let id = `${prefix}_`;
  for (let i = 0; i < 5; i++) id += CHARS[Math.floor(Math.random() * CHARS.length)];
  return id;
}
