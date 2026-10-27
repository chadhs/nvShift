export const MAX_TREE_NODES = 250000;
export const MAX_TREE_DEPTH = 128;
export const MAX_PREVIEW_CHARACTERS = 32 * 1024 * 1024;
export const MAX_METADATA_CHARACTERS = 128 * 1024;
export const PROCESSING_TIMEOUT_MS = 15000;

export function visitTree(root, callback) {
  const stack = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++count > MAX_TREE_NODES) throw new Error('Document exceeds the 250,000-node preview limit');
    if (depth > MAX_TREE_DEPTH) throw new Error('Document exceeds the 128-level nesting limit');
    callback(node);
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], depth: depth + 1 });
  }
}
