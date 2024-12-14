import { relative } from "node:path";
import * as vscode from "vscode";
import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  LspClient,
  SymbolInformation,
  SymbolKind,
} from "./ts-lsp-client";

interface RecursiveCallHierarchyIncomingCall extends CallHierarchyIncomingCall {
  from: RecursiveCallHierarchyItem;
}

interface RecursiveCallHierarchyItem extends CallHierarchyItem {
  incomingCalls: RecursiveCallHierarchyIncomingCall[];
}

function nodeToKey(item: RecursiveCallHierarchyItem) {
  return `${item.uri.toString()}::${item.name}`;
}

interface LineageCodeLens extends vscode.CodeLens {
  startNode: RecursiveCallHierarchyItem;
}

const GO_FUNCTION_NAME_PATTERN =
  /\s*func\s*(?:\(\s*(?:(?:[A-Za-z]|\p{Nd})+)?\s*\*?\s*(?:(?:[A-Za-z]|\p{Nd})+)\s*\))?\s*((?:[A-Za-z]|\p{Nd})+)\s*\(/du;

const DEFAULT_STYLES = `
  // Graph-level styling
  graph [
    rankdir=TB, // Top-to-bottom layout
    fontname="Courier",
    fontsize=12
  ];

  // Default node styling
  node [
    shape=box,
    style="rounded,filled",
    fontname="Courier",
    fontsize=10,
  ];

  // Default edge styling
  edge [
    arrowhead=vee,
    arrowsize=0.8,
    penwidth=1.5,
  ];
`;

// Function to generate Graphviz DOT representation
function generateGraphvizDot(
  startNode: RecursiveCallHierarchyItem,
  rootPath: string
): string {
  const relativePath = (uri: string) =>
    relative(rootPath, decodeURIComponent(new URL(uri).pathname));

  const edges = new Set<string>();
  const nodes = new Set<string>();
  const rootNodes = new Set<string>();
  const nodesById = new Map<String, CallHierarchyItem>();
  const callSiteLines = new Map<string, Set<number>>();

  const addCallSiteLines = (nodeId: string, newCallSites: number[]) => {
    const existing = callSiteLines.get(nodeId);
    if (!existing) {
      callSiteLines.set(nodeId, new Set(newCallSites));
    } else {
      for (const site of newCallSites) {
        existing.add(site);
      }
    }
  };

  const traverse = (node: RecursiveCallHierarchyItem) => {
    const nodeId = `${node.name}_${relativePath(node.uri)}`;

    // Check if its a root node
    if (node.incomingCalls.length === 0) {
      rootNodes.add(nodeId);
    }

    for (const incomingCall of node.incomingCalls) {
      const childNodeId = `${incomingCall.from.name}_${relativePath(
        incomingCall.from.uri
      )}`;

      nodesById.set(childNodeId, incomingCall.from);

      addCallSiteLines(
        childNodeId,
        incomingCall.fromRanges.map((r) => r.start.line)
      );

      const edge = `"${childNodeId}" -> "${nodeId}";`;
      if (!edges.has(edge)) {
        edges.add(edge);
      }

      traverse(incomingCall.from); // Recurse into children
    }
  };

  nodesById.set(`${startNode.name}_${relativePath(startNode.uri)}`, startNode);
  callSiteLines.set(
    `${startNode.name}_${relativePath(startNode.uri)}`,
    new Set([startNode.range.start.line])
  );
  traverse(startNode);

  for (const [nodeId, lines] of callSiteLines.entries()) {
    const node = nodesById.get(nodeId)!;
    const linesArray = [...lines].map((line) => line + 1);
    linesArray.sort((a, b) => a - b);
    let label = `${node.name}\\n${relativePath(node.uri)}${
      linesArray.length > 0 ? ":" + linesArray : ""
    }`;

    if (rootNodes.has(nodeId)) {
      nodes.add(`"${nodeId}" [label="${label}", class="root"];`);
    } else {
      nodes.add(`"${nodeId}" [label="${label}"];`);
    }
  }

  return `digraph ${startNode.name} {
    rankdir=TB; // Top-to-bottom layout
    ${DEFAULT_STYLES}
    ${Array.from(nodes).join("\n  ")}
    ${Array.from(edges).join("\n  ")}
  }`;
}

export class LineageCodeLensProvider
  implements vscode.CodeLensProvider<LineageCodeLens>
{
  nodesAlreadyVisited = new Map<string, RecursiveCallHierarchyIncomingCall[]>();
  hits = 0;
  misses = 0;
  constructor(
    private getLspClient: () => LspClient | null,
    private graphvizMap: Map<string, string>,
    private rootPath: string
  ) {
    // Notify the editor that code lenses need updating if max path segments config changes
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("codeLineage.maxPathSegments") ||
        event.affectsConfiguration("codeLineage.maxLensLength")
      ) {
        this._onDidChangeCodeLenses.fire();
      }
    });
  }

  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  notify() {
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<LineageCodeLens[]> {
    const lspClient = this.getLspClient();
    if (!lspClient) {
      return [];
    }

    const results = (await lspClient.documentSymbol({
      textDocument: {
        uri: document.uri.toString(),
      },
    })) as SymbolInformation[] | null;

    if (!results || token.isCancellationRequested) {
      return [];
    }

    const codeLenses: LineageCodeLens[] = [];

    for (const { location, kind } of results) {
      if (token.isCancellationRequested) {
        return [];
      }

      if (kind === SymbolKind.Function || kind === SymbolKind.Method) {
        const startLine = document.lineAt(location.range.start.line);
        const match = startLine.text.match(GO_FUNCTION_NAME_PATTERN);
        if (!match) {
          continue;
        }

        const prepareResult = await lspClient.prepareCallHierarchy({
          textDocument: {
            uri: document.uri.toString(),
          },
          position: {
            line: location.range.start.line,
            character: match.indices![1][0],
          },
        });

        if (!prepareResult) {
          continue;
        }

        const startItem = prepareResult[0];
        const startNode = {
          ...startItem,
          incomingCalls: [],
        } as RecursiveCallHierarchyItem;

        const lens = new vscode.CodeLens(startLine.range) as LineageCodeLens;
        lens.startNode = startNode;
        codeLenses.push(lens);
      }
    }

    return codeLenses;
  }

  async resolveCodeLens(
    codeLens: LineageCodeLens,
    token: vscode.CancellationToken
  ): Promise<LineageCodeLens | null> {
    const lspClient = this.getLspClient();
    if (!lspClient) {
      return null;
    }

    const startNode = codeLens.startNode;
    const startNodeKey = nodeToKey(startNode);

    // Recursively fetch the incoming calls and build the tree
    const buildCallHierarchy = async (item: RecursiveCallHierarchyItem) => {
      if (token.isCancellationRequested) {
        return;
      }

      const maybeIncomingCalls = this.nodesAlreadyVisited.get(nodeToKey(item));
      if (maybeIncomingCalls) {
        this.hits++;
        item.incomingCalls = maybeIncomingCalls;
        return;
      } else {
        this.misses++;
      }

      const incomingCallsResult = await lspClient!.incomingCalls({
        item,
      });

      if (!incomingCallsResult) {
        return null;
      }

      for (const incomingCall of incomingCallsResult) {
        // Ignore test code
        if (
          incomingCall.from.uri.endsWith("_test.go") ||
          incomingCall.from.uri.includes("component_test")
        ) {
          continue;
        }

        const callNode = {
          ...incomingCall.from,
          incomingCalls: [],
        } as RecursiveCallHierarchyItem;

        item.incomingCalls.push({
          from: callNode,
          fromRanges: incomingCall.fromRanges,
        });
        await buildCallHierarchy(callNode); // Recurse into the next level
      }

      this.nodesAlreadyVisited.set(nodeToKey(item), item.incomingCalls);
    };

    await buildCallHierarchy(startNode);

    // Function is not called from anywhere, skip it
    if (startNode.incomingCalls.length === 0) {
      codeLens.command = {
        title: "Not called anywhere",
        command: "",
      };

      return codeLens;
    }

    // Generate Graphviz content for the function and store it in the map
    const graphvizContent = generateGraphvizDot(startNode, this.rootPath);
    this.graphvizMap.set(startNodeKey, graphvizContent);

    // Build paths to bottom from root for code lenses
    let pathsForFunction = [] as string[][];
    const stack = [{ node: startNode, path: [] as string[] }];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;

      // If node is not called from anywhere, it's the root,
      // turn it into a code lens
      if (node.incomingCalls.length === 0) {
        pathsForFunction.push([node.name, ...path]);
      }

      for (const incomingCall of node.incomingCalls) {
        for (const fromRange of incomingCall.fromRanges) {
          const lineOffset =
            fromRange.start.line - incomingCall.from.range.start.line;

          stack.push({
            node: incomingCall.from,
            path: [lineOffset.toString(), ...path],
          });
        }
      }
    }

    const config = vscode.workspace.getConfiguration("codeLineage");
    const maxPathSegments = config.get<number>("maxPathSegments", 0);
    let maxLensLength = config.get<number>("maxLensLength", 80);
    if (isNaN(maxLensLength) || maxLensLength < 1) {
      maxLensLength = 80;
    }

    if (maxPathSegments > 0) {
      pathsForFunction = pathsForFunction.map((path) => {
        if (path.length <= maxPathSegments + 1) {
          return path;
        }
        return path.slice(0, maxPathSegments + 1);
      });
    }

    // De-duplicate
    pathsForFunction = [
      ...new Set(pathsForFunction.map((p) => p.join("."))),
    ].map((p) => p.split("."));

    // Figure out the first and last call path from each root function
    const firstAndLastForRoot = new Map<
      /*root*/ string,
      { firstPath: number[]; lastPath: number[] }
    >();

    for (let path of pathsForFunction) {
      const root = path[0];
      const offsetPath = path.slice(1).map((seg) => parseInt(seg));

      const firstAndLast = firstAndLastForRoot.get(root);
      if (!firstAndLast) {
        firstAndLastForRoot.set(root, {
          firstPath: offsetPath,
          lastPath: offsetPath,
        });
        continue;
      }

      const { firstPath, lastPath } = firstAndLast;
      if (comparePaths(offsetPath, firstPath) === -1) {
        firstAndLast.firstPath = offsetPath;
      }
      if (comparePaths(offsetPath, lastPath) === 1) {
        firstAndLast.lastPath = offsetPath;
      }
    }

    // Build a piece of the lens for each root function
    const lensPieces: string[] = [];
    const roots = [...firstAndLastForRoot.keys()].sort();
    for (const root of roots) {
      if (root === "init") {
        lensPieces.push("init");
        continue;
      }

      const { firstPath, lastPath } = firstAndLastForRoot.get(root)!;
      const firstPathString = firstPath.join(".");
      const lastPathString = lastPath.join(".");

      lensPieces.push(
        `${root}:${
          firstPathString === lastPathString
            ? firstPathString
            : combinePaths(firstPath, lastPath)
        }`
      );
    }

    // Trim the amount of paths to fit in a reasonable amount of space.
    let title = lensPieces.join(", ");
    let excess = 0;
    while (title.length > maxLensLength && lensPieces.length > 1) {
      lensPieces.pop();
      excess++;
      title = lensPieces.join(", ");
    }
    if (excess > 0) {
      title += `, and ${excess} more`;
    }

    codeLens.command = {
      title,
      tooltip: "Show call graph for this function",
      command: "codeLineage.showCallGraph",
      arguments: [startNodeKey],
    };

    return codeLens;
  }
}

/** Compare two paths segment-by-segment */
function comparePaths(a: number[], b: number[]) {
  const segmentsToCompare = Math.min(a.length, b.length);
  for (let i = 0; i < segmentsToCompare; i++) {
    if (a[i] < b[i]) {
      return -1;
    }
    if (a[i] > b[i]) {
      return 1;
    }
  }

  // They were the same up until one ended, so the shorter path is first
  if (a.length < b.length) {
    return -1;
  }
  return 1;
}

/** Combines two paths, pulling out the common segments at the beginning
 *
 * `combinePaths([1, 2, 3], [4, 5, 6]) == '1.2.3..4.5.6'`
 *
 * `combinePaths([1, 2, 3, 4, 5], [1, 2, 3, 6, 7]) == '1.2.3.[4.5..6.7]'`
 *
 * `combinePaths([1, 2, 3], [1, 2, 3, 4, 5]) == '1.2.3.[..4.5]'`
 */
function combinePaths(first: number[], last: number[]): string {
  const segmentsToCompare = Math.min(first.length, last.length);

  for (let i = 0; i < segmentsToCompare; i++) {
    if (first[i] !== last[i]) {
      if (i === 0) {
        return `${first.join(".")}..${last.join(".")}}`;
      }
      return (
        first.slice(0, i).join(".") +
        `.[${first.slice(i).join(".")}..${last.slice(i).join(".")}]`
      );
    }
  }

  return first.join(".") + `.[..${last.slice(first.length).join(".")}]`;
}
