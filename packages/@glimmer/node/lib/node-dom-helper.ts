import type {
  Bounds,
  Nullable,
  SimpleDocument,
  SimpleElement,
  SimpleNode,
} from '@glimmer/interfaces';
import { ConcreteBounds, DOMTreeConstruction } from '@glimmer/runtime';
import createHTMLDocument from '@simple-dom/document';

export default class NodeDOMTreeConstruction extends DOMTreeConstruction {
  declare protected document: SimpleDocument; // Hides property on base class
  constructor(doc: Nullable<SimpleDocument>) {
    super(doc || createHTMLDocument());
  }

  // override to prevent usage of `this.document` until after the constructor
  protected override setupUselessElement() {}

  override insertHTMLBefore(
    parent: SimpleElement,
    reference: Nullable<SimpleNode>,
    html: string
  ): Bounds {
    // eslint-disable-next-line @typescript-eslint/no-deprecated, @typescript-eslint/no-non-null-assertion
    let raw = this.document.createRawHTMLSection!(html);
    parent.insertBefore(raw, reference);
    return new ConcreteBounds(parent, raw, raw);
  }

  // override to avoid SVG detection/work when in node (this is not needed in SSR)
  override createElement(tag: string) {
    return this.document.createElement(tag);
  }

  // override to avoid namespace shenanigans when in node (this is not needed in SSR)
  override setAttribute(element: SimpleElement, name: string, value: string) {
    element.setAttribute(name, value);
  }
}
