import { lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function requirePrivate(stat, type, path) {
  if (!stat[type]() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new Error(`Expected an owner-only ${type === 'isFile' ? 'file' : 'directory'}: ${path}`);
  }
}

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  requirePrivate(lstatSync(path), 'isDirectory', path);
}

export function privateFile(path, { mustExist = false } = {}) {
  privateDirectory(dirname(path));
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) requirePrivate(stat, 'isFile', path);
  else if (mustExist) throw new Error(`Database file does not exist: ${path}`);
}
