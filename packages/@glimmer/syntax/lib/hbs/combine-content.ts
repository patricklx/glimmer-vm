import * as hbs from '../types/handlebars-ast';
import { unreachable, assign } from '@glimmer/util';

export function combineContent<T extends hbs.AnyProgram>(program: T): T {
  let statements: hbs.Statement[] = [];
  let body = program.body;

  if (body === null) {
    return program;
  }

  for (let i = 0; i < body.length; i++) {
    let item = body[i];

    if (isContent(item)) {
      while (true) {
        let next = body[i + 1];

        if (isContent(next)) {
          i++;
          item = join(item, next);
        } else {
          item = join(item);
          break;
        }
      }
    } else if (item.type === 'BlockStatement') {
      item.program = combineContent(item.program);
      if (item.inverses) {
        item.inverses = item.inverses.map(inverse => combineContent(inverse));
      }
    }

    statements.push(item);
  }

  return assign(program, { body: statements });
}

type Content = hbs.ContentStatement | hbs.Newline;

function isContent(item: hbs.Statement | undefined): item is Content {
  return item !== undefined && (item.type === 'ContentStatement' || item.type === 'Newline');
}

function join(left: Content, right?: Content): hbs.ContentStatement {
  let span = { start: left.span.start, end: right ? right.span.end : left.span.end };
  let value: string;

  if (right === undefined) {
    if (left.type === 'Newline') {
      value = '\n';
    } else {
      value = left.value;
    }
  } else if (left.type === 'Newline' && right.type === 'Newline') {
    value = '\n\n';
  } else if (left.type === 'Newline' && right.type === 'ContentStatement') {
    value = `\n${right.value}`;
  } else if (left.type === 'ContentStatement' && right.type === 'Newline') {
    value = `${left.value}\n`;
  } else if (left.type === 'ContentStatement' && right.type === 'ContentStatement') {
    value = `${left.value}${right.value}`;
  } else {
    throw unreachable();
  }

  return {
    type: 'ContentStatement',
    span,
    value,
  };
}