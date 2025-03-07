import type * as ASTv1 from './v1/api';

import { isKeyword } from './keywords';
import { preprocess } from './parser/tokenizer-event-handlers';
import traverse from './traversal/traverse';

interface GetTemplateLocalsOptions {
  includeKeywords?: boolean;
  includeHtmlElements?: boolean;
}

/**
 * Gets the correct Token from the Node based on it's type
 */
function getPathName(
  node: ASTv1.Node,
  scopedTokens: string[],
  options: GetTemplateLocalsOptions
): string | void {
  if (node.type === 'PathExpression') {
    if (node.head.type === 'AtHead' || node.head.type === 'ThisHead') {
      return;
    }

    const possbleToken = node.head.name;

    if (scopedTokens.indexOf(possbleToken) === -1) {
      return possbleToken;
    }
  } else if (node.type === 'ElementNode') {
    const { tag } = node;

    const char = tag.charAt(0);

    if (char === ':' || char === '@') {
      return;
    }

    if (!options.includeHtmlElements && tag.indexOf('.') === -1 && tag.toLowerCase() === tag) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- @fixme
    if (tag.substr(0, 5) === 'this.') {
      return;
    }

    // the tag may be from a yielded object
    // example:
    //   <x.button>
    // An ElementNode does not parse the "tag" in to a PathExpression
    // so we have to split on `.`, just like how `this` presence is checked.
    if (tag.includes('.')) {
      let [potentialLocal] = tag.split('.') as [string, ...string[]];

      if (scopedTokens.includes(potentialLocal)) return;
    }

    if (scopedTokens.includes(tag)) return;

    return tag;
  }
}

/**
 * Adds tokens to the tokensSet based on their node.type
 */
function addTokens(
  tokensSet: Set<string>,
  node: ASTv1.Node,
  scopedTokens: string[],
  options: GetTemplateLocalsOptions
) {
  const maybePathName = getPathName(node, scopedTokens, options);

  if (maybePathName !== undefined && maybePathName[0] !== '@') {
    const maybeFirstPathSegment = maybePathName.split('.')[0];
    if (maybeFirstPathSegment && !scopedTokens.includes(maybeFirstPathSegment)) {
      tokensSet.add(maybeFirstPathSegment);
    }
  }
}

/**
 * Parses and traverses a given handlebars html template to extract all template locals
 * referenced that could possible come from the parent scope. Can exclude known keywords
 * optionally.
 */
export function getTemplateLocals(
  html: string,
  options: GetTemplateLocalsOptions = {
    includeHtmlElements: false,
    includeKeywords: false,
  }
): string[] {
  const ast = preprocess(html);
  const tokensSet = new Set<string>();
  const scopedTokens: string[] = [];

  traverse(ast, {
    Block: {
      enter({ blockParams }) {
        blockParams.forEach((param) => {
          scopedTokens.push(param);
        });
      },

      exit({ blockParams }) {
        blockParams.forEach(() => {
          scopedTokens.pop();
        });
      },
    },

    ElementNode: {
      enter(node) {
        node.blockParams.forEach((param) => {
          scopedTokens.push(param);
        });
        addTokens(tokensSet, node, scopedTokens, options);
      },

      exit({ blockParams }) {
        blockParams.forEach(() => {
          scopedTokens.pop();
        });
      },
    },

    PathExpression(node) {
      addTokens(tokensSet, node, scopedTokens, options);
    },
  });

  let tokens: string[] = [];

  tokensSet.forEach((s) => tokens.push(s));

  if (!options.includeKeywords) {
    tokens = tokens.filter((token) => !isKeyword(token));
  }

  return tokens;
}
