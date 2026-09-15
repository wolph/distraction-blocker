/**
 * Shared CDP frame-tree and accessibility-tree shapes for locating and clicking a control inside a
 * closed shadow root (src/content/overlay-host.ts), used by both the interactive demo e2e spec and
 * the README media capture script. A closed shadow root refuses `.shadowRoot` to every piece of
 * page JavaScript, Playwright's own locators included, so no CSS or role locator can reach in. The
 * CDP Accessibility domain, scoped to a frame, still reports a button and its on-screen box: the
 * accessibility tree is built from the flattened render tree, not from the script-visible shadow
 * root reference that `closed` withholds.
 */

/** A tab iframe on the demo page, addressed by the CDP frame tree, one id and url per frame. */
export interface FrameTreeNode {
  frame: { id: string; url: string };
  childFrames?: FrameTreeNode[];
}

export interface FrameTree {
  frameTree: FrameTreeNode;
}

export interface AccessibilityProperty {
  name?: string;
  value?: { value?: unknown };
}

export interface AccessibilityNode {
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: AccessibilityProperty[];
}

export interface AccessibilityTree {
  nodes: AccessibilityNode[];
}

/** Depth-first search of a CDP frame tree for the frame whose URL ends with the given suffix. */
export function findFrameId(node: FrameTreeNode, urlSuffix: string): string | undefined {
  if (node.frame.url.endsWith(urlSuffix)) return node.frame.id;
  for (const child of node.childFrames ?? []) {
    const found: string | undefined = findFrameId(child, urlSuffix);
    if (found !== undefined) return found;
  }
  return undefined;
}
