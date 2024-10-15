import type {
  ComputeReference,
  ConstantReference,
  InvokableReference,
  Nullable,
  Reference,
  ReferenceSymbol,
  ReferenceType,
  UnboundReference,
} from '@glimmer/interfaces';
import type { Revision, Tag } from '@glimmer/validator';
import { getProp, setProp } from '@glimmer/global-context';
import { expect, isDict } from '@glimmer/util';
import {
  CONSTANT_TAG,
  consumeTag,
  INITIAL,
  track,
  validateTag,
  valueForTag,
} from '@glimmer/validator';

export const REFERENCE: ReferenceSymbol = Symbol('REFERENCE') as ReferenceSymbol;

const CONSTANT: ConstantReference = 0;
const COMPUTE: ComputeReference = 1;
const UNBOUND: UnboundReference = 2;
const INVOKABLE: InvokableReference = 3;

export type { Reference as default };
export type { Reference };

//////////

export interface ReferenceEnvironment {
  getProp(obj: unknown, path: string): unknown;
  setProp(obj: unknown, path: string, value: unknown): unknown;
}

class ReferenceImpl<T = unknown> implements Reference<T> {
  [REFERENCE]: ReferenceType;
  public tag: Nullable<Tag> = null;
  public lastRevision: Revision = INITIAL;
  public lastValue?: T;

  public children: Nullable<Map<string | Reference, Reference>> = null;

  public compute: Nullable<() => T> = null;
  public update: Nullable<(val: T) => void> = null;

  public debugLabel?: string;
  public debugMeta?: object;

  constructor(type: ReferenceType) {
    this[REFERENCE] = type;
  }
}

export function createPrimitiveRef<T extends string | symbol | number | boolean | null | undefined>(
  value: T
): Reference<T> {
  const ref = new ReferenceImpl<T>(UNBOUND);

  ref.tag = CONSTANT_TAG;
  ref.lastValue = value;

  if (import.meta.env.DEV) {
    ref.debugLabel = String(value);
  }

  return ref;
}

export const UNDEFINED_REFERENCE = createPrimitiveRef(undefined);
export const NULL_REFERENCE = createPrimitiveRef(null);
export const TRUE_REFERENCE = createPrimitiveRef(true as const);
export const FALSE_REFERENCE = createPrimitiveRef(false as const);

export function createConstRef<T>(value: T, debugLabel: false | string, meta?: object | undefined): Reference<T> {
  const ref = new ReferenceImpl<T>(CONSTANT);

  ref.lastValue = value;
  ref.tag = CONSTANT_TAG;

  if (import.meta.env.DEV) {
    ref.debugLabel = String(debugLabel || value);
    ref.debugMeta = meta;
  }

  return ref;
}

export function createUnboundRef<T>(value: T, debugLabel: false | string, meta?: object | undefined): Reference<T> {
  const ref = new ReferenceImpl<T>(UNBOUND);

  ref.lastValue = value;
  ref.tag = CONSTANT_TAG;

  if (import.meta.env.DEV) {
    ref.debugLabel = debugLabel as string;
    ref.debugMeta = meta;
  }

  return ref;
}

export function createComputeRef<T = unknown>(
  compute: () => T,
  update: Nullable<(value: T) => void> = null,
  debugLabel: false | string = 'unknown',
  meta?: object | undefined
): Reference<T> {
  const ref = new ReferenceImpl<T>(COMPUTE);

  ref.compute = compute;
  ref.update = update;

  if (import.meta.env.DEV) {
    ref.debugLabel = `(result of a \`${debugLabel}\` helper)`;
    ref.debugMeta = meta;
  }

  return ref;
}

export function createReadOnlyRef(ref: Reference): Reference {
  if (!isUpdatableRef(ref)) return ref;

  return createComputeRef(() => valueForRef(ref), null, ref.debugLabel);
}

export function isInvokableRef(ref: Reference) {
  return ref[REFERENCE] === INVOKABLE;
}

export function createInvokableRef(inner: Reference): Reference {
  const ref = createComputeRef(
    () => valueForRef(inner),
    (value) => updateRef(inner, value)
  );
  ref.debugLabel = inner.debugLabel;
  ref[REFERENCE] = INVOKABLE;

  return ref;
}

export function isConstRef(_ref: Reference) {
  const ref = _ref as ReferenceImpl;

  return ref.tag === CONSTANT_TAG;
}

export function isUpdatableRef(_ref: Reference) {
  const ref = _ref as ReferenceImpl;

  return ref.update !== null;
}

const trackedRefs = new Map();
const refStack = [];
let isTraceEnabled = false;

export function setEnableRefTrace(enable: boolean) {
  isTraceEnabled = enable;
}

function getCurrentRef() {
  return refStack.at(-1);
}

export function getRefsTrace() {
  const copy = new Map(trackedRefs);
  trackedRefs.clear();
  return copy;
}

export function valueForRef<T>(_ref: Reference<T>): T {
  const ref = _ref as ReferenceImpl<T>;

  if (import.meta.env.DEV && isTraceEnabled) {
    if (refStack.length) {
      trackedRefs.get(getCurrentRef()).push(ref);
    }
  }

  let { tag } = ref;

  if (tag === CONSTANT_TAG) {
    return ref.lastValue as T;
  }

  const { lastRevision } = ref;
  let lastValue;

  if (import.meta.env.DEV && isTraceEnabled) {
    refStack.push(ref);
    trackedRefs.set(ref, []);
  }

  if (tag === null || !validateTag(tag, lastRevision)) {
    const { compute } = ref;

    const newTag = track(
      () => {
        lastValue = ref.lastValue = compute!();
      },
      import.meta.env.DEV && ref.debugLabel
    );

    tag = ref.tag = newTag;

    ref.lastRevision = valueForTag(newTag);
  } else {
    lastValue = ref.lastValue;
  }

  consumeTag(tag);

  if (import.meta.env.DEV && isTraceEnabled) {
    refStack.pop();
  }

  return lastValue as T;
}

export function updateRef(_ref: Reference, value: unknown) {
  const ref = _ref as ReferenceImpl;

  const update = expect(ref.update, 'called update on a non-updatable reference');

  update(value);
}

export function childRefFor(_parentRef: Reference, path: string): Reference {
  const parentRef = _parentRef as ReferenceImpl;

  const type = parentRef[REFERENCE];

  let children = parentRef.children;
  let child: Reference;

  if (children === null) {
    children = parentRef.children = new Map();
  } else {
    child = children.get(path)!;

    if (child !== undefined) {
      return child;
    }
  }

  if (type === UNBOUND) {
    const parent = valueForRef(parentRef);

    if (isDict(parent)) {
      child = createUnboundRef(
        (parent as Record<string, unknown>)[path],
        import.meta.env.DEV && `${parentRef.debugLabel}.${path}`
      );
    } else {
      child = UNDEFINED_REFERENCE;
    }
  } else {
    child = createComputeRef(
      () => {
        const parent = valueForRef(parentRef);

        if (isDict(parent)) {
          return getProp(parent, path);
        }
      },
      (val) => {
        const parent = valueForRef(parentRef);

        if (isDict(parent)) {
          return setProp(parent, path, val);
        }
      }
    );

    if (import.meta.env.DEV) {
      child.debugLabel = `${parentRef.debugLabel}.${path}`;
    }
  }

  children.set(path, child);

  return child;
}

export function childRefFromParts(root: Reference, parts: string[]): Reference {
  let reference = root;

  for (const part of parts) {
    reference = childRefFor(reference, part);
  }

  return reference;
}

export let createDebugAliasRef: undefined | ((debugLabel: string, inner: Reference) => Reference);

if (import.meta.env.DEV) {
  createDebugAliasRef = (debugLabel: string, inner: Reference) => {
    const update = isUpdatableRef(inner) ? (value: unknown) => updateRef(inner, value) : null;
    const ref = createComputeRef(() => valueForRef(inner), update);

    ref[REFERENCE] = inner[REFERENCE];

    ref.debugLabel = debugLabel;

    return ref;
  };
}
