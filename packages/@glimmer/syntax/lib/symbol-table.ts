import type { Core, Dict } from '@glimmer/interfaces';
import { setLocalDebugType, unwrap } from '@glimmer/debug-util';
import { dict } from '@glimmer/util';
import { SexpOpcodes } from '@glimmer/wire-format';

import * as ASTv2 from './v2/api';

export interface Upvar {
  readonly name: string;
  readonly resolution: ASTv2.FreeVarResolution;
}

interface SymbolTableOptions {
  customizeComponentName: (input: string) => string;
  lexicalScope: (variable: string) => boolean;
}

export abstract class SymbolTable {
  static top(
    locals: readonly string[],
    keywords: readonly string[],
    options: SymbolTableOptions
  ): ProgramSymbolTable {
    return new ProgramSymbolTable(locals, keywords, options);
  }

  abstract root(): ProgramSymbolTable;

  abstract has(name: string): boolean;
  abstract get(name: string): [symbol: number, isRoot: boolean];

  abstract hasKeyword(name: string): boolean;
  abstract getKeyword(name: string): number;

  abstract hasLexical(name: string): boolean;

  abstract getLocalsMap(): Dict<number>;
  abstract getDebugInfo(): Core.DebugSymbols;

  abstract allocateFree(name: string, resolution: ASTv2.FreeVarResolution): number;
  abstract allocateNamed(name: string): number;
  abstract allocateBlock(name: string): number;
  abstract allocate(identifier: string): number;

  child(locals: string[]): BlockSymbolTable {
    let symbols = locals.map((name) => this.allocate(name));
    return new BlockSymbolTable(this, locals, symbols);
  }
}

export class ProgramSymbolTable extends SymbolTable {
  constructor(
    private templateLocals: readonly string[],
    private keywords: readonly string[],
    private options: SymbolTableOptions
  ) {
    super();

    setLocalDebugType('syntax:symbol-table:program', this, {
      debug: () => ({
        templateLocals: this.templateLocals,
        keywords: this.keywords,
        symbols: this.symbols,
        upvars: this.upvars,
        named: this.named,
        blocks: this.blocks,
      }),
    });
  }

  readonly symbols: string[] = [];
  readonly upvars: string[] = [];

  private size = 1;
  readonly named = dict<number>();
  readonly blocks = dict<number>();
  readonly usedTemplateLocals: string[] = [];

  root(): this {
    return this;
  }

  hasLexical(name: string): boolean {
    return this.options.lexicalScope(name);
  }

  hasKeyword(name: string): boolean {
    return this.keywords.includes(name);
  }

  getKeyword(name: string): number {
    return this.allocateFree(name, ASTv2.STRICT_RESOLUTION);
  }

  getUsedTemplateLocals(): string[] {
    return this.usedTemplateLocals;
  }

  has(name: string): boolean {
    return this.templateLocals.includes(name);
  }

  get(name: string): [number, boolean] {
    let index = this.usedTemplateLocals.indexOf(name);

    if (index !== -1) {
      return [index, true];
    }

    index = this.usedTemplateLocals.length;
    this.usedTemplateLocals.push(name);
    return [index, true];
  }

  getLocalsMap(): Dict<number> {
    return dict();
  }

  getDebugInfo(): Core.DebugSymbols {
    return [this.getLocalsMap(), this.named];
  }

  allocateFree(name: string, resolution: ASTv2.FreeVarResolution): number {
    // If the name in question is an uppercase (i.e. angle-bracket) component invocation, run
    // the optional `customizeComponentName` function provided to the precompiler.
    if (
      resolution.resolution() === SexpOpcodes.GetFreeAsComponentHead &&
      resolution.isAngleBracket
    ) {
      name = this.options.customizeComponentName(name);
    }

    let index = this.upvars.indexOf(name);

    if (index !== -1) {
      return index;
    }

    index = this.upvars.length;
    this.upvars.push(name);
    return index;
  }

  allocateNamed(name: string): number {
    let named = this.named[name];

    if (!named) {
      named = this.named[name] = this.allocate(name);
    }

    return named;
  }

  allocateBlock(name: string): number {
    if (name === 'inverse') {
      name = 'else';
    }

    let block = this.blocks[name];

    if (!block) {
      block = this.blocks[name] = this.allocate(`&${name}`);
    }

    return block;
  }

  allocate(identifier: string): number {
    this.symbols.push(identifier);
    return this.size++;
  }
}

export class BlockSymbolTable extends SymbolTable {
  constructor(
    private parent: SymbolTable,
    public symbols: string[],
    public slots: number[]
  ) {
    super();
  }

  root(): ProgramSymbolTable {
    return this.parent.root();
  }

  get locals(): string[] {
    return this.symbols;
  }

  hasLexical(name: string): boolean {
    return this.parent.hasLexical(name);
  }

  getKeyword(name: string): number {
    return this.parent.getKeyword(name);
  }

  hasKeyword(name: string): boolean {
    return this.parent.hasKeyword(name);
  }

  has(name: string): boolean {
    return this.symbols.indexOf(name) !== -1 || this.parent.has(name);
  }

  get(name: string): [number, boolean] {
    let local = this.#get(name);
    return local ? [local, false] : this.parent.get(name);
  }

  #get(name: string): number | null {
    let slot = this.symbols.indexOf(name);
    return slot === -1 ? null : unwrap(this.slots[slot]);
  }

  getLocalsMap(): Dict<number> {
    let dict = this.parent.getLocalsMap();
    this.symbols.forEach((symbol) => (dict[symbol] = this.get(symbol)[0]));
    return dict;
  }

  getDebugInfo(): [locals: Record<string, number>, upvars: Record<string, number>] {
    const locals = this.getLocalsMap();
    const root = this.root();
    const named = root.named;

    return [{ ...locals, ...named }, Object.fromEntries(root.upvars.map((s, i) => [s, i]))];
  }

  allocateFree(name: string, resolution: ASTv2.FreeVarResolution): number {
    return this.parent.allocateFree(name, resolution);
  }

  allocateNamed(name: string): number {
    return this.parent.allocateNamed(name);
  }

  allocateBlock(name: string): number {
    return this.parent.allocateBlock(name);
  }

  allocate(identifier: string): number {
    return this.parent.allocate(identifier);
  }
}
