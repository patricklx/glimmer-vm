import {
  Option,
  LayoutWithContext,
  ContainingMetadata,
  SerializedInlineBlock,
  WireFormat,
  SymbolTable,
  CompilableTemplate,
  Statement,
  CompileTimeCompilationContext,
  CompilableBlock,
  CompilableProgram,
  HandleResult,
  BlockSymbolTable,
  SerializedBlock,
} from '@glimmer/interfaces';
import { meta } from './opcode-builder/helpers/shared';
import { EMPTY_ARRAY } from '@glimmer/util';
import { templateCompilationContext } from './opcode-builder/context';
import { concatStatements } from './syntax/concat';
import { LOCAL_SHOULD_LOG } from '@glimmer/local-debug-flags';
import { debugCompiler } from './compiler';
import { patchStdlibs } from '@glimmer/program';
import { STATEMENTS } from './syntax/statements';

export const PLACEHOLDER_HANDLE = -1;

class CompilableTemplateImpl<S extends SymbolTable> implements CompilableTemplate<S> {
  compiled: Option<HandleResult> = null;

  constructor(
    readonly statements: WireFormat.Statement[],
    readonly meta: ContainingMetadata,
    // Part of CompilableTemplate
    readonly symbolTable: S
  ) {}

  // Part of CompilableTemplate
  compile(context: CompileTimeCompilationContext): HandleResult {
    return maybeCompile(this, context);
  }
}

export function compilable(layout: LayoutWithContext): CompilableProgram {
  let [statements, symbols, hasEval] = layout.block;
  return new CompilableTemplateImpl(statements, meta(layout), {
    symbols,
    hasEval,
  });
}

function maybeCompile(
  compilable: CompilableTemplateImpl<SymbolTable>,
  context: CompileTimeCompilationContext
): HandleResult {
  if (compilable.compiled !== null) return compilable.compiled!;

  compilable.compiled = PLACEHOLDER_HANDLE;

  let { statements, meta } = compilable;

  let result = compileStatements(statements, meta, context);
  patchStdlibs(context);
  compilable.compiled = result;

  return result;
}

export function compileStatements(
  statements: Statement[],
  meta: ContainingMetadata,
  syntaxContext: CompileTimeCompilationContext
): HandleResult {
  let sCompiler = STATEMENTS;
  let context = templateCompilationContext(syntaxContext, meta);

  for (let i = 0; i < statements.length; i++) {
    concatStatements(context, sCompiler.compile(statements[i], context.meta));
  }

  let handle = context.encoder.commit(syntaxContext.heap, meta.size);

  if (LOCAL_SHOULD_LOG) {
    debugCompiler(context, handle);
  }

  return handle;
}

export function compilableBlock(
  block: SerializedInlineBlock | SerializedBlock,
  containing: ContainingMetadata
): CompilableBlock {
  return new CompilableTemplateImpl<BlockSymbolTable>(block[0], containing, {
    parameters: block[1] || (EMPTY_ARRAY as number[]),
  });
}
