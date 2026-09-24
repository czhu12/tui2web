import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * Decides how to launch the user's command. Real executables run directly.
 * Anything else (a shell alias like `claw`, or a shell function) only exists
 * inside the user's shell, so run it through their shell in interactive mode,
 * which loads ~/.zshrc / ~/.bashrc where aliases and functions are defined.
 */
export function resolveCommand(command: string[]): { file: string; args: string[] } {
  const [file, ...args] = command;
  if (process.platform === 'win32' || isExecutable(file)) return { file, args };
  const shell = process.env.SHELL || '/bin/sh';
  // No `exec`: aliases are only expanded in command position.
  return { file: shell, args: ['-ic', command.map(shellQuote).join(' ')] };
}

function isExecutable(file: string): boolean {
  if (file.includes('/')) return canExecute(isAbsolute(file) ? file : resolve(file));
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && canExecute(join(dir, file)));
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Quotes an argument for sh/bash/zsh, leaving plain words readable. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
