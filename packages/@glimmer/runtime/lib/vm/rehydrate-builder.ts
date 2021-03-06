import { Bounds, ElementBuilder, Environment, Option } from '@glimmer/interfaces';
import { assert, cast, expect, Maybe, Stack } from '@glimmer/util';
import {
  AttrNamespace,
  Namespace,
  NodeType,
  SimpleAttr,
  SimpleComment,
  SimpleElement,
  SimpleNode,
  SimpleText,
} from '@simple-dom/interface';
import { ConcreteBounds, CursorImpl } from '../bounds';
import { CURSOR_STACK, NewElementBuilder, RemoteLiveBlock } from './element-builder';

export const SERIALIZATION_FIRST_NODE_STRING = '%+b:0%';

export function isSerializationFirstNode(node: SimpleNode): boolean {
  return node.nodeValue === SERIALIZATION_FIRST_NODE_STRING;
}

export class RehydratingCursor extends CursorImpl {
  candidate: Option<SimpleNode> = null;
  openBlockDepth: number;
  injectedOmittedNode = false;
  constructor(
    element: SimpleElement,
    nextSibling: Option<SimpleNode>,
    public readonly startingBlockDepth: number
  ) {
    super(element, nextSibling);
    this.openBlockDepth = startingBlockDepth - 1;
  }
}

export class RehydrateBuilder extends NewElementBuilder implements ElementBuilder {
  private unmatchedAttributes: Option<SimpleAttr[]> = null;
  [CURSOR_STACK]!: Stack<RehydratingCursor>; // Hides property on base class
  blockDepth = 0;

  constructor(env: Environment, parentNode: SimpleElement, nextSibling: Option<SimpleNode>) {
    super(env, parentNode, nextSibling);
    if (nextSibling) throw new Error('Rehydration with nextSibling not supported');

    let node = this.currentCursor!.element.firstChild;

    while (node !== null) {
      if (isComment(node) && isSerializationFirstNode(node)) {
        break;
      }
      node = node.nextSibling;
    }

    assert(
      node,
      `Must have opening comment <!--${SERIALIZATION_FIRST_NODE_STRING}--> for rehydration.`
    );
    this.candidate = node;
  }

  get currentCursor(): Option<RehydratingCursor> {
    return this[CURSOR_STACK].current;
  }

  get candidate(): Option<SimpleNode> {
    if (this.currentCursor) {
      return this.currentCursor.candidate!;
    }

    return null;
  }

  set candidate(node: Option<SimpleNode>) {
    let currentCursor = this.currentCursor!;

    currentCursor.candidate = node;
  }

  disableRehydration(nextSibling: Option<SimpleNode>) {
    let currentCursor = this.currentCursor!;

    // rehydration will be disabled until we either:
    // * hit popElement (and return to using the parent elements cursor)
    // * hit closeBlock and the next sibling is a close block comment
    //   matching the expected openBlockDepth
    currentCursor.candidate = null;
    currentCursor.nextSibling = nextSibling;
  }

  enableRehydration(candidate: Option<SimpleNode>) {
    let currentCursor = this.currentCursor!;

    currentCursor.candidate = candidate;
    currentCursor.nextSibling = null;
  }

  pushElement(
    /** called from parent constructor before we initialize this */
    this:
      | RehydrateBuilder
      | (NewElementBuilder & Partial<Pick<RehydrateBuilder, 'blockDepth' | 'candidate'>>),
    element: SimpleElement,
    nextSibling: Maybe<SimpleNode> = null
  ) {
    let cursor = new RehydratingCursor(element, nextSibling, this.blockDepth || 0);

    /**
     * <div>   <---------------  currentCursor.element
     *   <!--%+b:1%--> <-------  would have been removed during openBlock
     *   <div> <---------------  currentCursor.candidate -> cursor.element
     *     <!--%+b:2%--> <-----  currentCursor.candidate.firstChild -> cursor.candidate
     *     Foo
     *     <!--%-b:2%-->
     *   </div>
     *   <!--%-b:1%-->  <------  becomes currentCursor.candidate
     */
    if (this.candidate !== null) {
      cursor.candidate = element.firstChild;
      this.candidate = element.nextSibling;
    }

    this[CURSOR_STACK].push(cursor);
  }

  // clears until the end of the current container
  // either the current open block or higher
  private clearMismatch(candidate: SimpleNode) {
    let current: Option<SimpleNode> = candidate;
    let currentCursor = this.currentCursor;
    if (currentCursor !== null) {
      let openBlockDepth = currentCursor.openBlockDepth;
      if (openBlockDepth >= currentCursor.startingBlockDepth) {
        while (current) {
          if (isCloseBlock(current)) {
            let closeBlockDepth = getBlockDepth(current);
            if (openBlockDepth >= closeBlockDepth) {
              break;
            }
          }
          current = this.remove(current);
        }
      } else {
        while (current !== null) {
          current = this.remove(current);
        }
      }
      // current cursor parentNode should be openCandidate if element
      // or openCandidate.parentNode if comment
      this.disableRehydration(current);
    }
  }

  __openBlock(): void {
    let { currentCursor } = this;
    if (currentCursor === null) return;

    let blockDepth = this.blockDepth;

    this.blockDepth++;

    let { candidate } = currentCursor;
    if (candidate === null) return;

    let { tagName } = currentCursor.element;

    if (isOpenBlock(candidate) && getBlockDepth(candidate) === blockDepth) {
      this.candidate = this.remove(candidate);
      currentCursor.openBlockDepth = blockDepth;
    } else if (tagName !== 'TITLE' && tagName !== 'SCRIPT' && tagName !== 'STYLE') {
      this.clearMismatch(candidate);
    }
  }

  __closeBlock(): void {
    let { currentCursor } = this;
    if (currentCursor === null) return;

    // openBlock is the last rehydrated open block
    let openBlockDepth = currentCursor.openBlockDepth;

    // this currently is the expected next open block depth
    this.blockDepth--;

    let { candidate } = currentCursor;

    let isRehydrating = false;

    if (candidate !== null) {
      isRehydrating = true;
      //assert(
      //  openBlockDepth === this.blockDepth,
      //  'when rehydrating, openBlockDepth should match this.blockDepth here'
      //);

      if (isCloseBlock(candidate) && getBlockDepth(candidate) === openBlockDepth) {
        let nextSibling = this.remove(candidate);
        this.candidate = nextSibling;
        currentCursor.openBlockDepth--;
      } else {
        // close the block and clear mismatch in parent container
        // we will be either at the end of the element
        // or at the end of our containing block
        this.clearMismatch(candidate);
        isRehydrating = false;
      }
    }

    if (isRehydrating === false) {
      // check if nextSibling matches our expected close block
      // if so, we remove the close block comment and
      // restore rehydration after clearMismatch disabled
      let nextSibling = currentCursor.nextSibling;
      if (
        nextSibling !== null &&
        isCloseBlock(nextSibling) &&
        getBlockDepth(nextSibling) === this.blockDepth
      ) {
        // restore rehydration state
        let candidate = this.remove(nextSibling);
        this.enableRehydration(candidate);

        currentCursor.openBlockDepth--;
      }
    }
  }

  __appendNode(node: SimpleNode): SimpleNode {
    let { candidate } = this;

    // This code path is only used when inserting precisely one node. It needs more
    // comparison logic, but we can probably lean on the cases where this code path
    // is actually used.
    if (candidate) {
      return candidate;
    } else {
      return super.__appendNode(node);
    }
  }

  __appendHTML(html: string): Bounds {
    let candidateBounds = this.markerBounds();

    if (candidateBounds) {
      let first = candidateBounds.firstNode()!;
      let last = candidateBounds.lastNode()!;

      let newBounds = new ConcreteBounds(this.element, first.nextSibling!, last.previousSibling!);

      let possibleEmptyMarker = this.remove(first);
      this.remove(last);

      if (possibleEmptyMarker !== null && isEmpty(possibleEmptyMarker)) {
        this.candidate = this.remove(possibleEmptyMarker);

        if (this.candidate !== null) {
          this.clearMismatch(this.candidate);
        }
      }

      return newBounds;
    } else {
      return super.__appendHTML(html);
    }
  }

  protected remove(node: SimpleNode): Option<SimpleNode> {
    let element = expect(node.parentNode, `cannot remove a detached node`) as SimpleElement;
    let next = node.nextSibling;
    element.removeChild(node);
    return next;
  }

  private markerBounds(): Option<Bounds> {
    let _candidate = this.candidate;

    if (_candidate && isMarker(_candidate)) {
      let first = _candidate;
      let last = expect(first.nextSibling, `BUG: serialization markers must be paired`);

      while (last && !isMarker(last)) {
        last = expect(last.nextSibling, `BUG: serialization markers must be paired`);
      }

      return new ConcreteBounds(this.element, first, last);
    } else {
      return null;
    }
  }

  __appendText(string: string): SimpleText {
    let { candidate } = this;

    if (candidate) {
      if (isTextNode(candidate)) {
        if (candidate.nodeValue !== string) {
          candidate.nodeValue = string;
        }
        this.candidate = candidate.nextSibling;

        return candidate;
      } else if (isSeparator(candidate)) {
        this.candidate = this.remove(candidate);

        return this.__appendText(string);
      } else if (isEmpty(candidate) && string === '') {
        this.candidate = this.remove(candidate);

        return this.__appendText(string);
      } else {
        this.clearMismatch(candidate);

        return super.__appendText(string);
      }
    } else {
      return super.__appendText(string);
    }
  }

  __appendComment(string: string): SimpleComment {
    let _candidate = this.candidate;
    if (_candidate && isComment(_candidate)) {
      if (_candidate.nodeValue !== string) {
        _candidate.nodeValue = string;
      }

      this.candidate = _candidate.nextSibling;
      return _candidate;
    } else if (_candidate) {
      this.clearMismatch(_candidate);
    }

    return super.__appendComment(string);
  }

  __openElement(tag: string): SimpleElement {
    let _candidate = this.candidate;

    if (_candidate && isElement(_candidate) && isSameNodeType(_candidate, tag)) {
      this.unmatchedAttributes = [].slice.call(_candidate.attributes);
      return _candidate;
    } else if (_candidate) {
      if (isElement(_candidate) && _candidate.tagName === 'TBODY') {
        this.pushElement(_candidate, null);
        this.currentCursor!.injectedOmittedNode = true;
        return this.__openElement(tag);
      }
      this.clearMismatch(_candidate);
    }

    return super.__openElement(tag);
  }

  __setAttribute(name: string, value: string, namespace: Option<AttrNamespace>): void {
    let unmatched = this.unmatchedAttributes;

    if (unmatched) {
      let attr = findByName(unmatched, name);
      if (attr) {
        if (attr.value !== value) {
          attr.value = value;
        }
        unmatched.splice(unmatched.indexOf(attr), 1);
        return;
      }
    }

    return super.__setAttribute(name, value, namespace);
  }

  __setProperty(name: string, value: string): void {
    let unmatched = this.unmatchedAttributes;

    if (unmatched) {
      let attr = findByName(unmatched, name);
      if (attr) {
        if (attr.value !== value) {
          attr.value = value;
        }
        unmatched.splice(unmatched.indexOf(attr), 1);
        return;
      }
    }

    return super.__setProperty(name, value);
  }

  __flushElement(parent: SimpleElement, constructing: SimpleElement): void {
    let { unmatchedAttributes: unmatched } = this;
    if (unmatched) {
      for (let i = 0; i < unmatched.length; i++) {
        this.constructing!.removeAttribute(unmatched[i].name);
      }
      this.unmatchedAttributes = null;
    } else {
      super.__flushElement(parent, constructing);
    }
  }

  willCloseElement() {
    let { candidate, currentCursor } = this;

    if (candidate !== null) {
      this.clearMismatch(candidate);
    }

    if (currentCursor && currentCursor.injectedOmittedNode) {
      this.popElement();
    }

    super.willCloseElement();
  }

  getMarker(element: HTMLElement, guid: string): Option<SimpleNode> {
    let marker = element.querySelector(`script[glmr="${guid}"]`);
    if (marker) {
      return cast(marker, 'NODE').simple;
    }
    return null;
  }

  __pushRemoteElement(
    element: SimpleElement,
    cursorId: string,
    insertBefore: Maybe<SimpleNode>
  ): Option<RemoteLiveBlock> {
    let marker = this.getMarker(cast(element, 'HTML').node, cursorId);

    assert(
      !marker || marker.parentNode === element,
      `expected remote element marker's parent node to match remote element`
    );

    // when insertBefore is not present, we clear the element
    if (insertBefore === undefined) {
      while (element.firstChild !== null && element.firstChild !== marker) {
        this.remove(element.firstChild);
      }
      insertBefore = null;
    }

    let cursor = new RehydratingCursor(element, null, this.blockDepth);
    this[CURSOR_STACK].push(cursor);

    if (marker === null) {
      this.disableRehydration(insertBefore);
    } else {
      this.candidate = this.remove(marker);
    }

    let block = new RemoteLiveBlock(element);
    return this.pushLiveBlock(block, true);
  }

  didAppendBounds(bounds: Bounds): Bounds {
    super.didAppendBounds(bounds);
    if (this.candidate) {
      let last = bounds.lastNode();
      this.candidate = last && last.nextSibling;
    }
    return bounds;
  }
}

function isTextNode(node: SimpleNode): node is SimpleText {
  return node.nodeType === 3;
}

function isComment(node: SimpleNode): node is SimpleComment {
  return node.nodeType === 8;
}

function isOpenBlock(node: SimpleNode): node is SimpleComment {
  return node.nodeType === NodeType.COMMENT_NODE && node.nodeValue.lastIndexOf('%+b:', 0) === 0;
}

function isCloseBlock(node: SimpleNode): node is SimpleComment {
  return node.nodeType === NodeType.COMMENT_NODE && node.nodeValue.lastIndexOf('%-b:', 0) === 0;
}

function getBlockDepth(node: SimpleComment): number {
  return parseInt(node.nodeValue.slice(4), 10);
}

function isElement(node: SimpleNode): node is SimpleElement {
  return node.nodeType === 1;
}

function isMarker(node: SimpleNode): boolean {
  return node.nodeType === 8 && node.nodeValue === '%glmr%';
}

function isSeparator(node: SimpleNode): boolean {
  return node.nodeType === 8 && node.nodeValue === '%|%';
}

function isEmpty(node: SimpleNode): boolean {
  return node.nodeType === 8 && node.nodeValue === '% %';
}

function isSameNodeType(candidate: SimpleElement, tag: string) {
  if (candidate.namespaceURI === Namespace.SVG) {
    return candidate.tagName === tag;
  }
  return candidate.tagName === tag.toUpperCase();
}

function findByName(array: SimpleAttr[], name: string): SimpleAttr | undefined {
  for (let i = 0; i < array.length; i++) {
    let attr = array[i];
    if (attr.name === name) return attr;
  }

  return undefined;
}

export function rehydrationBuilder(env: Environment, cursor: CursorImpl): ElementBuilder {
  return RehydrateBuilder.forInitialRender(env, cursor);
}
