import { getFirst, getLast, isPresentArray } from '@glimmer/debug-util';

import { enumerate } from './array-utils';

export function strip(strings: TemplateStringsArray, ...args: unknown[]) {
  let out = '';
  for (const [i, string] of enumerate(strings)) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- @fixme
    let dynamic = args[i] !== undefined ? String(args[i]) : '';

    out += `${string}${dynamic}`;
  }

  let lines = out.split('\n');

  while (isPresentArray(lines) && /^\s*$/u.test(getFirst(lines))) {
    lines.shift();
  }

  while (isPresentArray(lines) && /^\s*$/u.test(getLast(lines))) {
    lines.pop();
  }

  let min = Infinity;

  for (let line of lines) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
    let leading = /^\s*/u.exec(line)![0].length;

    min = Math.min(min, leading);
  }

  let stripped = [];

  for (let line of lines) {
    stripped.push(line.slice(min));
  }

  return stripped.join('\n');
}
