import type { VariableKind } from '@glimmer/constants';
import type {
  AttrNamespace,
  Dict,
  Expressions,
  GetContextualFreeOpcode,
  Nullable,
  PresentArray,
  WireFormat,
} from '@glimmer/interfaces';
import {
  APPEND_EXPR_HEAD,
  APPEND_PATH_HEAD,
  ARG_VAR,
  BLOCK_HEAD,
  BLOCK_VAR,
  BUILDER_COMMENT,
  BUILDER_LITERAL,
  CALL_EXPR,
  CALL_HEAD,
  COMMENT_HEAD,
  CONCAT_EXPR,
  DYNAMIC_COMPONENT_HEAD,
  ELEMENT_HEAD,
  FREE_VAR,
  GET_PATH_EXPR,
  GET_VAR_EXPR,
  HAS_BLOCK_EXPR,
  HAS_BLOCK_PARAMS_EXPR,
  KEYWORD_HEAD,
  LITERAL_EXPR,
  LITERAL_HEAD,
  LOCAL_VAR,
  MODIFIER_HEAD,
  NS_XLINK,
  NS_XML,
  NS_XMLNS,
  SPLAT_HEAD,
  THIS_VAR,
} from '@glimmer/constants';
import { exhausted, expect, isPresentArray, localAssert } from '@glimmer/debug-util';
import { assertNever, dict, values } from '@glimmer/util';
import { SexpOpcodes as Op, VariableResolutionContext } from '@glimmer/wire-format';

import type {
  BuilderComment,
  BuilderStatement,
  NormalizedAngleInvocation,
  NormalizedAttrs,
  NormalizedBlock,
  NormalizedBlocks,
  NormalizedElement,
  NormalizedExpression,
  NormalizedHash,
  NormalizedHead,
  NormalizedKeywordStatement,
  NormalizedParams,
  NormalizedPath,
  NormalizedStatement,
  Variable,
} from './builder-interface';

import { normalizeStatement } from './builder-interface';

interface Symbols {
  top: ProgramSymbols;
  freeVar(name: string): number;
  arg(name: string): number;
  block(name: string): number;
  local(name: string): number;
  this(): number;

  hasLocal(name: string): boolean;

  child(params: string[]): LocalSymbols;
}

export class ProgramSymbols implements Symbols {
  _freeVariables: string[] = [];
  _symbols: string[] = ['this'];

  top = this;

  toSymbols(): string[] {
    return this._symbols.slice(1);
  }

  toUpvars(): string[] {
    return this._freeVariables;
  }

  freeVar(name: string): number {
    return addString(this._freeVariables, name);
  }

  block(name: string): number {
    return this.symbol(name);
  }

  arg(name: string): number {
    return addString(this._symbols, name);
  }

  local(name: string): never {
    throw new Error(
      `No local ${name} was found. Maybe you meant ^${name} for upvar, or !${name} for keyword?`
    );
  }

  this(): number {
    return 0;
  }

  hasLocal(_name: string): false {
    return false;
  }

  // any symbol
  symbol(name: string): number {
    return addString(this._symbols, name);
  }

  child(locals: string[]): LocalSymbols {
    return new LocalSymbols(this, locals);
  }
}

class LocalSymbols implements Symbols {
  private locals: Dict<number> = dict();

  constructor(
    private parent: Symbols,
    locals: string[]
  ) {
    for (let local of locals) {
      this.locals[local] = parent.top.symbol(local);
    }
  }

  get paramSymbols(): number[] {
    return values(this.locals);
  }

  get top(): ProgramSymbols {
    return this.parent.top;
  }

  freeVar(name: string): number {
    return this.parent.freeVar(name);
  }

  arg(name: string): number {
    return this.parent.arg(name);
  }

  block(name: string): number {
    return this.parent.block(name);
  }

  local(name: string): number {
    if (name in this.locals) {
      return this.locals[name] as number;
    } else {
      return this.parent.local(name);
    }
  }

  this(): number {
    return this.parent.this();
  }

  hasLocal(name: string): boolean {
    if (name in this.locals) {
      return true;
    } else {
      return this.parent.hasLocal(name);
    }
  }

  child(locals: string[]): LocalSymbols {
    return new LocalSymbols(this, locals);
  }
}

function addString(array: string[], item: string): number {
  let index = array.indexOf(item);

  if (index === -1) {
    index = array.length;
    array.push(item);
    return index;
  } else {
    return index;
  }
}

export interface BuilderGetFree {
  type: 'GetFree';
  head: string;
  tail: string[];
}

function unimpl(message: string): Error {
  return new Error(`unimplemented ${message}`);
}

export function buildStatements(
  statements: BuilderStatement[],
  symbols: Symbols
): WireFormat.Statement[] {
  let out: WireFormat.Statement[] = [];

  statements.forEach((s) => out.push(...buildStatement(normalizeStatement(s), symbols)));

  return out;
}

export function buildNormalizedStatements(
  statements: NormalizedStatement[],
  symbols: Symbols
): WireFormat.Statement[] {
  let out: WireFormat.Statement[] = [];

  statements.forEach((s) => out.push(...buildStatement(s, symbols)));

  return out;
}

export function buildStatement(
  normalized: NormalizedStatement,
  symbols: Symbols = new ProgramSymbols()
): WireFormat.Statement[] {
  switch (normalized.kind) {
    case APPEND_PATH_HEAD: {
      return [
        [
          normalized.trusted ? Op.TrustingAppend : Op.Append,
          buildGetPath(normalized.path, symbols),
        ],
      ];
    }

    case APPEND_EXPR_HEAD: {
      return [
        [
          normalized.trusted ? Op.TrustingAppend : Op.Append,
          buildExpression(
            normalized.expr,
            normalized.trusted ? 'TrustedAppend' : 'Append',
            symbols
          ),
        ],
      ];
    }

    case CALL_HEAD: {
      let { head: path, params, hash, trusted } = normalized;
      let builtParams: Nullable<WireFormat.Core.Params> = params
        ? buildParams(params, symbols)
        : null;
      let builtHash: WireFormat.Core.Hash = hash ? buildHash(hash, symbols) : null;
      let builtExpr: WireFormat.Expression = buildCallHead(
        path,
        trusted
          ? VariableResolutionContext.ResolveAsHelperHead
          : VariableResolutionContext.ResolveAsComponentOrHelperHead,
        symbols
      );

      return [
        [trusted ? Op.TrustingAppend : Op.Append, [Op.Call, builtExpr, builtParams, builtHash]],
      ];
    }

    case LITERAL_HEAD: {
      return [[Op.Append, normalized.value]];
    }

    case COMMENT_HEAD: {
      return [[Op.Comment, normalized.value]];
    }

    case BLOCK_HEAD: {
      let blocks = buildBlocks(normalized.blocks, normalized.blockParams, symbols);
      let hash = buildHash(normalized.hash, symbols);
      let params = buildParams(normalized.params, symbols);
      let path = buildCallHead(
        normalized.head,
        VariableResolutionContext.ResolveAsComponentHead,
        symbols
      );

      return [[Op.Block, path, params, hash, blocks]];
    }

    case KEYWORD_HEAD: {
      return [buildKeyword(normalized, symbols)];
    }

    case ELEMENT_HEAD:
      return buildElement(normalized, symbols);

    case MODIFIER_HEAD:
      throw unimpl('modifier');

    case DYNAMIC_COMPONENT_HEAD:
      throw unimpl('dynamic component');

    default:
      assertNever(normalized);
  }
}

export function s(
  arr: TemplateStringsArray,
  ...interpolated: unknown[]
): [BUILDER_LITERAL, string] {
  let result = arr.reduce(
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- @fixme
    (result, string, i) => result + `${string}${interpolated[i] ? String(interpolated[i]) : ''}`,
    ''
  );

  return [BUILDER_LITERAL, result];
}

export function c(arr: TemplateStringsArray, ...interpolated: unknown[]): BuilderComment {
  let result = arr.reduce(
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- @fixme
    (result, string, i) => result + `${string}${interpolated[i] ? String(interpolated[i]) : ''}`,
    ''
  );

  return [BUILDER_COMMENT, result];
}

export function unicode(charCode: string): string {
  return String.fromCharCode(parseInt(charCode, 16));
}

export const NEWLINE = '\n';

function buildKeyword(
  normalized: NormalizedKeywordStatement,
  symbols: Symbols
): WireFormat.Statement {
  let { name } = normalized;
  let params = buildParams(normalized.params, symbols);
  let childSymbols = symbols.child(normalized.blockParams || []);

  let block = buildBlock(
    normalized.blocks['default'] as NormalizedBlock,
    childSymbols,
    childSymbols.paramSymbols
  );
  let inverse = normalized.blocks['else']
    ? buildBlock(normalized.blocks['else'], symbols, [])
    : null;

  switch (name) {
    case 'let':
      return [Op.Let, expect(params, 'let requires params'), block];
    case 'if':
      return [Op.If, expect(params, 'if requires params')[0], block, inverse];
    case 'each': {
      let keyExpr = normalized.hash ? normalized.hash['key'] : null;
      let key = keyExpr ? buildExpression(keyExpr, 'Strict', symbols) : null;
      return [Op.Each, expect(params, 'if requires params')[0], key, block, inverse];
    }

    default:
      throw new Error('unimplemented keyword');
  }
}

function buildElement(
  { name, attrs, block }: NormalizedElement,
  symbols: Symbols
): WireFormat.Statement[] {
  let out: WireFormat.Statement[] = [
    hasSplat(attrs) ? [Op.OpenElementWithSplat, name] : [Op.OpenElement, name],
  ];
  if (attrs) {
    let { params, args } = buildElementParams(attrs, symbols);
    out.push(...params);
    localAssert(args === null, `Can't pass args to a simple element`);
  }
  out.push([Op.FlushElement]);

  if (Array.isArray(block)) {
    block.forEach((s) => out.push(...buildStatement(s, symbols)));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    localAssert(block === null, `The only remaining type of 'block' is 'null'`);
  }

  out.push([Op.CloseElement]);

  return out;
}

function hasSplat(attrs: Nullable<NormalizedAttrs>): boolean {
  if (attrs === null) return false;

  return Object.keys(attrs).some((a) => attrs[a] === SPLAT_HEAD);
}

export function buildAngleInvocation(
  { attrs, block, head }: NormalizedAngleInvocation,
  symbols: Symbols
): WireFormat.Statements.Component {
  let paramList: WireFormat.ElementParameter[] = [];
  let args: WireFormat.Core.Hash = null;
  let blockList: WireFormat.Statement[] = [];

  if (attrs) {
    let built = buildElementParams(attrs, symbols);
    paramList = built.params;
    args = built.args;
  }

  if (block) blockList = buildNormalizedStatements(block, symbols);

  return [
    Op.Component,
    buildExpression(head, VariableResolutionContext.ResolveAsComponentHead, symbols),
    isPresentArray(paramList) ? paramList : null,
    args,
    [['default'], [[blockList, []]]],
  ];
}

export function buildElementParams(
  attrs: NormalizedAttrs,
  symbols: Symbols
): { params: WireFormat.ElementParameter[]; args: WireFormat.Core.Hash } {
  let params: WireFormat.ElementParameter[] = [];
  let keys: string[] = [];
  let values: WireFormat.Expression[] = [];

  for (const [key, value] of Object.entries(attrs)) {
    if (value === SPLAT_HEAD) {
      params.push([Op.AttrSplat, symbols.block('&attrs')]);
    } else if (key[0] === '@') {
      keys.push(key);
      values.push(buildExpression(value, 'Strict', symbols));
    } else {
      params.push(
        ...buildAttributeValue(
          key,
          value,
          // TODO: extract namespace from key
          extractNamespace(key),
          symbols
        )
      );
    }
  }

  return { params, args: isPresentArray(keys) && isPresentArray(values) ? [keys, values] : null };
}

export function extractNamespace(name: string): Nullable<AttrNamespace> {
  if (name === 'xmlns') {
    return NS_XMLNS;
  }

  let match = /^([^:]*):([^:]*)$/u.exec(name);

  if (match === null) {
    return null;
  }

  let namespace = match[1];

  switch (namespace) {
    case 'xlink':
      return NS_XLINK;
    case 'xml':
      return NS_XML;
    case 'xmlns':
      return NS_XMLNS;
  }

  return null;
}

export function buildAttributeValue(
  name: string,
  value: NormalizedExpression,
  namespace: Nullable<AttrNamespace>,
  symbols: Symbols
): WireFormat.Attribute[] {
  switch (value.type) {
    case LITERAL_EXPR: {
      let val = value.value;

      if (val === false) {
        return [];
      } else if (val === true) {
        return [[Op.StaticAttr, name, '', namespace ?? undefined]];
      } else if (typeof val === 'string') {
        return [[Op.StaticAttr, name, val, namespace ?? undefined]];
      } else {
        throw new Error(`Unexpected/unimplemented literal attribute ${JSON.stringify(val)}`);
      }
    }

    default:
      return [
        [
          Op.DynamicAttr,
          name,
          buildExpression(value, 'AttrValue', symbols),
          namespace ?? undefined,
        ],
      ];
  }
}

type ExprResolution =
  | VariableResolutionContext
  | 'Append'
  | 'TrustedAppend'
  | 'AttrValue'
  | 'SubExpression'
  | 'Strict';

function varContext(context: ExprResolution, bare: boolean): VarResolution {
  switch (context) {
    case 'Append':
      return bare ? 'AppendBare' : 'AppendInvoke';
    case 'TrustedAppend':
      return bare ? 'TrustedAppendBare' : 'TrustedAppendInvoke';
    case 'AttrValue':
      return bare ? 'AttrValueBare' : 'AttrValueInvoke';
    default:
      return context;
  }
}

export function buildExpression(
  expr: NormalizedExpression,
  context: ExprResolution,
  symbols: Symbols
): WireFormat.Expression {
  switch (expr.type) {
    case GET_PATH_EXPR: {
      return buildGetPath(expr, symbols);
    }

    case GET_VAR_EXPR: {
      return buildVar(expr.variable, varContext(context, true), symbols);
    }

    case CONCAT_EXPR: {
      return [Op.Concat, buildConcat(expr.params, symbols)];
    }

    case CALL_EXPR: {
      let builtParams = buildParams(expr.params, symbols);
      let builtHash = buildHash(expr.hash, symbols);
      let builtExpr = buildCallHead(
        expr.head,
        context === 'Strict' ? 'SubExpression' : varContext(context, false),
        symbols
      );

      return [Op.Call, builtExpr, builtParams, builtHash];
    }

    case HAS_BLOCK_EXPR: {
      return [
        Op.HasBlock,
        buildVar(
          { kind: BLOCK_VAR, name: expr.name, mode: 'loose' },
          VariableResolutionContext.Strict,
          symbols
        ),
      ];
    }

    case HAS_BLOCK_PARAMS_EXPR: {
      return [
        Op.HasBlockParams,
        buildVar(
          { kind: BLOCK_VAR, name: expr.name, mode: 'loose' },
          VariableResolutionContext.Strict,
          symbols
        ),
      ];
    }

    case LITERAL_EXPR: {
      if (expr.value === undefined) {
        return [Op.Undefined];
      } else {
        return expr.value;
      }
    }

    default:
      assertNever(expr);
  }
}

export function buildCallHead(
  callHead: NormalizedHead,
  context: VarResolution,
  symbols: Symbols
): Expressions.GetVar | Expressions.GetPath {
  if (callHead.type === GET_VAR_EXPR) {
    return buildVar(callHead.variable, context, symbols);
  } else {
    return buildGetPath(callHead, symbols);
  }
}

export function buildGetPath(head: NormalizedPath, symbols: Symbols): Expressions.GetPath {
  return buildVar(head.path.head, VariableResolutionContext.Strict, symbols, head.path.tail);
}

type VarResolution =
  | VariableResolutionContext
  | 'AppendBare'
  | 'AppendInvoke'
  | 'TrustedAppendBare'
  | 'TrustedAppendInvoke'
  | 'AttrValueBare'
  | 'AttrValueInvoke'
  | 'SubExpression'
  | 'Strict';

export function buildVar(
  head: Variable,
  context: VarResolution,
  symbols: Symbols,
  path: PresentArray<string>
): Expressions.GetPath;
export function buildVar(
  head: Variable,
  context: VarResolution,
  symbols: Symbols
): Expressions.GetVar;
export function buildVar(
  head: Variable,
  context: VarResolution,
  symbols: Symbols,
  path?: PresentArray<string>
): Expressions.GetPath | Expressions.GetVar {
  let op: Expressions.GetPath[0] | Expressions.GetVar[0] = Op.GetSymbol;
  let sym: number;
  switch (head.kind) {
    case FREE_VAR:
      if (context === 'Strict') {
        op = Op.GetStrictKeyword;
      } else if (context === 'AppendBare') {
        op = Op.GetFreeAsComponentOrHelperHead;
      } else if (context === 'AppendInvoke') {
        op = Op.GetFreeAsComponentOrHelperHead;
      } else if (context === 'TrustedAppendBare') {
        op = Op.GetFreeAsHelperHead;
      } else if (context === 'TrustedAppendInvoke') {
        op = Op.GetFreeAsHelperHead;
      } else if (context === 'AttrValueBare') {
        op = Op.GetFreeAsHelperHead;
      } else if (context === 'AttrValueInvoke') {
        op = Op.GetFreeAsHelperHead;
      } else if (context === 'SubExpression') {
        op = Op.GetFreeAsHelperHead;
      } else {
        op = expressionContextOp(context);
      }
      sym = symbols.freeVar(head.name);
      break;
    default:
      op = Op.GetSymbol;
      sym = getSymbolForVar(head.kind, symbols, head.name);
  }

  if (path === undefined || path.length === 0) {
    return [op, sym];
  } else {
    localAssert(op !== Op.GetStrictKeyword, '[BUG] keyword with a path');
    return [op, sym, path];
  }
}

function getSymbolForVar(kind: Exclude<VariableKind, FREE_VAR>, symbols: Symbols, name: string) {
  switch (kind) {
    case ARG_VAR:
      return symbols.arg(name);
    case BLOCK_VAR:
      return symbols.block(name);
    case LOCAL_VAR:
      return symbols.local(name);
    case THIS_VAR:
      return symbols.this();
    default:
      return exhausted(kind);
  }
}

export function expressionContextOp(context: VariableResolutionContext): GetContextualFreeOpcode {
  switch (context) {
    case VariableResolutionContext.Strict:
      return Op.GetStrictKeyword;
    case VariableResolutionContext.ResolveAsComponentOrHelperHead:
      return Op.GetFreeAsComponentOrHelperHead;
    case VariableResolutionContext.ResolveAsHelperHead:
      return Op.GetFreeAsHelperHead;
    case VariableResolutionContext.ResolveAsModifierHead:
      return Op.GetFreeAsModifierHead;
    case VariableResolutionContext.ResolveAsComponentHead:
      return Op.GetFreeAsComponentHead;
    default:
      return exhausted(context);
  }
}

export function buildParams(
  exprs: Nullable<NormalizedParams>,
  symbols: Symbols
): Nullable<WireFormat.Core.Params> {
  if (exprs === null || !isPresentArray(exprs)) return null;

  return exprs.map((e) => buildExpression(e, 'Strict', symbols)) as WireFormat.Core.ConcatParams;
}

export function buildConcat(
  exprs: [NormalizedExpression, ...NormalizedExpression[]],
  symbols: Symbols
): WireFormat.Core.ConcatParams {
  return exprs.map((e) => buildExpression(e, 'AttrValue', symbols)) as WireFormat.Core.ConcatParams;
}

export function buildHash(exprs: Nullable<NormalizedHash>, symbols: Symbols): WireFormat.Core.Hash {
  if (exprs === null) return null;

  let out: [string[], WireFormat.Expression[]] = [[], []];

  for (const [key, value] of Object.entries(exprs)) {
    out[0].push(key);
    out[1].push(buildExpression(value, 'Strict', symbols));
  }

  return out as WireFormat.Core.Hash;
}

export function buildBlocks(
  blocks: NormalizedBlocks,
  blockParams: Nullable<string[]>,
  parent: Symbols
): WireFormat.Core.Blocks {
  let keys: string[] = [];
  let values: WireFormat.SerializedInlineBlock[] = [];

  for (const [name, block] of Object.entries(blocks)) {
    keys.push(name);

    if (name === 'default') {
      let symbols = parent.child(blockParams || []);

      values.push(buildBlock(block, symbols, symbols.paramSymbols));
    } else {
      values.push(buildBlock(block, parent, []));
    }
  }

  return [keys, values];
}

function buildBlock(
  block: NormalizedBlock,
  symbols: Symbols,
  locals: number[] = []
): WireFormat.SerializedInlineBlock {
  return [buildNormalizedStatements(block, symbols), locals];
}
