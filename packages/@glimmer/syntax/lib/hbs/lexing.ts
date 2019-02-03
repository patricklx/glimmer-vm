import { Option } from '@glimmer/interfaces';
import { TokenKind } from './lex';
import { Diagnostic, reportError } from './parser';
import { Span } from '../types/handlebars-ast';

export const EOF_SPAN = { start: -1, end: -1 };

export interface Position {
  offset: number;
}

export interface Tokens {
  peek(): LexItem<TokenKind>;
  consume(): LexItem<TokenKind>;
}

export type Ok<T> = { status: 'ok'; value: T };
export type Err = { status: 'err'; value: Diagnostic };

export type Result<T> = Ok<T> | Err;

export type Spanned<T> = { value: T; span: Span };
export type LexItem<T> = { kind: T; span: Span };

export type LexerNext<S, T> =
  | {
      type: 'eof';
    }
  | {
      type: 'remain';
      value: LexerAccumulate<T>;
    }
  | {
      type: 'transition';
      value: LexerAccumulate<T>;
      state: S;
    }
  | {
      type: 'push-state';
      value: LexerAccumulate<T>;
      state: S;
    }
  | {
      type: 'pop-state';
      value: LexerAccumulate<T>;
      state: S;
    };

export type LexerAccumulate<T> =
  | {
      type: 'begin';
    }
  | {
      type: 'nothing';
    }
  | {
      type: 'continue';
      action: LexerAction;
    }
  | {
      type: 'skip';
      action: LexerAction;
    }
  | {
      type: 'emit';
      before?: LexerAction;
      after?: LexerAction;
      token: T;
    };

type LoopCompletion<T> =
  | {
      type: 'continue';
    }
  | { type: 'return'; value: T };

type LexerAction = { type: 'consume'; amount: number } | { type: 'reconsume' };
export interface LexerDelegate<S, T> {
  token: T;

  for(state: S): LexerDelegate<S, T>;

  top(): this;
  eof(): T;

  next(char: Option<string>, rest: string): LexerNext<S, T>;

  clone(): LexerDelegate<S, T>;
}

export class Lexer<T, S> {
  private rest: string;
  private tokenStart: string;
  private state: LexerDelegate<S, T>;

  private startPos = 0;
  private tokenLen = 0;
  private stack: LexerDelegate<S, T>[] = [];

  constructor(
    private input: string,
    private delegate: LexerDelegate<S, T>,
    private errors: Diagnostic[]
  ) {
    this.rest = input;
    this.tokenStart = input;
    this.state = delegate.top();
  }

  next(): Result<LexItem<T>> {
    let count = 0;

    while (true) {
      count += 1;

      if (count > 1000) {
        return Err(reportError(this.errors, 'infinite loop detected', { start: -1, end: -1 }));
      }

      let { state, rest } = this;

      let nextChar: Option<string> = rest.length > 0 ? rest[0] : null;

      let next = state.next(nextChar, rest);

      let step = this.step(next);

      switch (step.type) {
        case 'continue':
          continue;
        case 'return':
          return this.emit(step.value);
      }
    }
  }

  step(next: LexerNext<S, T>): LoopCompletion<Result<LexItem<T>>> {
    switch (next.type) {
      case 'eof':
        return {
          type: 'return',
          value: Ok({ token: this.delegate.eof(), span: EOF_SPAN }),
        };

      case 'remain':
        return this.accumulate(next.value);

      case 'transition': {
        let ret = this.accumulate(next.value);
        this.transition(this.delegate.for(next.state));
        return ret;
      }

      case 'push-state': {
        let ret = this.accumulate(next.value);
        this.stack.push(this.delegate.for(next.state));

        this.transition(this.delegate.for(next.state));

        return ret;
      }

      case 'pop-state': {
        let ret = this.accumulate(next.value);
        let state = this.stack.pop()!;
        this.transition(state);

        return ret;
      }
    }
  }

  emit(token: Result<LexItem<T>>): Result<LexItem<T>> {
    return token;
  }

  transition(state: LexerDelegate<S, T>): void {
    this.state = state;
  }

  accumulate(accum: LexerAccumulate<T>): LoopCompletion<Result<LexItem<T>>> {
    switch (accum.type) {
      case 'begin':
        return { type: 'continue' };

      case 'nothing':
        return { type: 'continue' };

      case 'continue':
        this.action(accum.action);

        return { type: 'continue' };

      case 'skip':
        this.action(accum.action);

        this.startPos += this.tokenLen;
        this.tokenLen = 0;

        return { type: 'continue' };

      case 'emit':
        let { before, token } = accum;

        if (before !== undefined) {
          this.action(before);
        }

        let { startPos, tokenLen } = this;

        this.startPos = startPos + tokenLen;
        this.tokenLen = 0;

        return {
          type: 'return',
          value: Ok({
            token,
            span: { start: startPos, end: startPos + tokenLen },
          }),
        };
    }
  }

  action(action: LexerAction) {
    switch (action.type) {
      case 'consume':
        this.tokenLen += action.amount;
        this.rest = this.rest.slice(action.amount);
        return;

      case 'reconsume':
        return;
    }
  }
}

export function Ok<T>(value: T): Result<T> {
  return { status: 'ok', value };
}

export function Err<T>(diagnostic: Diagnostic): Result<T> {
  return { status: 'err', value: diagnostic };
}

export function Begin<S, T>(state: S): LexerNext<S, T> {
  return { type: 'transition', value: { type: 'begin' }, state };
}

export function Consume(c: string | number = 1): LexerAction {
  return { type: 'consume', amount: typeof c === 'string' ? c.length : c };
}

export function Reconsume(): LexerAction {
  return { type: 'reconsume' };
}

export function Continue<T>(action: LexerAction): LexerAccumulate<T> {
  return { type: 'continue', action };
}

export function Emit<T>(
  token: T,
  { first, andThen }: { first?: LexerAction; andThen?: LexerAction } = {}
): LexerAccumulate<T> {
  return { type: 'emit', token, before: first, after: andThen };
}

export function Remain<S, T>(accum: LexerAccumulate<T>): LexerNext<S, T> {
  return { type: 'remain', value: accum };
}

export function Transition<S, T>(accum: LexerAccumulate<T>, state: S): LexerNext<S, T> {
  return { type: 'transition', value: accum, state };
}

export function EOF<S, T>(): LexerNext<S, T> {
  return { type: 'eof' };
}
